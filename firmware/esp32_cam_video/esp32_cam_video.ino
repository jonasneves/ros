/**
 * ESP32-CAM-MB — Motor control via MQTT + MJPEG video stream over HTTP
 *
 * MQTT topics (MAC-based):
 *   devices/<mac>/motors/command   ← {"left": 0.5, "right": -0.5}
 *
 * Video stream:
 *   http://<device-ip>/stream      — MJPEG, open in browser or <img src="...">
 *   The device IP and stream URL are printed to Serial on boot.
 *
 * The stream URL is also published in the device announcement so the
 * MQTT AI Dashboard can show the camera feed automatically.
 *
 * GPIO wiring (L298N → ESP32-CAM-MB):
 *   ENA → GPIO 14    ENB → GPIO 4
 *   IN1 → GPIO 12    IN3 → GPIO 15
 *   IN2 → GPIO 13    IN4 → GPIO 16
 *
 * Note: GPIO 4 drives the onboard flash LED in addition to ENB.
 *       GPIO 16 is shared with PSRAM — PSRAM is disabled here to free it.
 *       If you need PSRAM, remap IN4 to GPIO 2 and update ENB_PIN below.
 *
 * Required libraries (Tools → Manage Libraries):
 *   - PubSubClient by Nick O'Leary
 *
 * Board: AI Thinker ESP32-CAM
 * Partition scheme: Huge APP (3MB No OTA / 1MB SPIFFS) — needed for camera + OTA
 */

#include <WiFi.h>
#include <ArduinoOTA.h>
#include <PubSubClient.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

#ifndef WIFI_SSID
#define WIFI_SSID "your_wifi_ssid"
#endif
#ifndef WIFI_PASS
#define WIFI_PASS "your_wifi_password"
#endif
#ifndef MQTT_IP
#define MQTT_IP "broker.hivemq.com"
#endif

const int           MQTT_PORT             = 1883;
const unsigned long RECONNECT_INTERVAL_MS = 5000;
const unsigned long COMMAND_TIMEOUT_MS    = 500;

// ── Camera pins (AI Thinker ESP32-CAM) ───────────────────────────────────────

#define PWDN_GPIO_NUM   32
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM    0
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define Y9_GPIO_NUM     35
#define Y8_GPIO_NUM     34
#define Y7_GPIO_NUM     39
#define Y6_GPIO_NUM     36
#define Y5_GPIO_NUM     21
#define Y4_GPIO_NUM     19
#define Y3_GPIO_NUM     18
#define Y2_GPIO_NUM      5
#define VSYNC_GPIO_NUM  25
#define HREF_GPIO_NUM   23
#define PCLK_GPIO_NUM   22

// ── Motor pins (L298N) ────────────────────────────────────────────────────────

const int ENA = 14;
const int IN1 = 12;
const int IN2 = 13;
const int ENB =  4;
const int IN3 = 15;
const int IN4 = 16;

const int PWM_FREQ  = 1000;
const int PWM_RES   = 8;
const int PWM_CH_L  = 0;
const int PWM_CH_R  = 1;

// ── Globals ───────────────────────────────────────────────────────────────────

const char* TOPIC_PREFIX = "devices/";

String motorsTopic;
String announceTopic;
String clientId;
String announcement;

unsigned long lastCommandMs = 0;

WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

httpd_handle_t cameraHttpd = NULL;

// ── Camera ────────────────────────────────────────────────────────────────────

bool setupCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_2;  // 0 and 1 used by motors
  config.ledc_timer   = LEDC_TIMER_1;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size   = FRAMESIZE_QVGA;  // 320×240 — reliable without PSRAM
  config.jpeg_quality = 12;              // 0–63, lower = better quality
  config.fb_count     = 2;
  config.fb_location  = CAMERA_FB_IN_DRAM;  // no PSRAM, keeps GPIO 16 free
  config.grab_mode    = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[Camera] Init failed: 0x%x\n", err);
    return false;
  }
  Serial.println("[Camera] Ready");
  return true;
}

// ── MJPEG stream handler ──────────────────────────────────────────────────────

static esp_err_t streamHandler(httpd_req_t *req) {
  camera_fb_t *fb = NULL;
  char buf[64];

  httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=frame");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache");

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) { vTaskDelay(10 / portTICK_PERIOD_MS); continue; }

    size_t hlen = snprintf(buf, sizeof(buf),
      "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", fb->len);

    esp_err_t res = httpd_resp_send_chunk(req, buf, hlen);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, "\r\n", 2);

    esp_camera_fb_return(fb);

    if (res != ESP_OK) break;  // client disconnected
  }
  return ESP_OK;
}

void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.stack_size  = 8192;  // extra stack for frame processing

  httpd_uri_t streamUri = {
    .uri     = "/stream",
    .method  = HTTP_GET,
    .handler = streamHandler,
    .user_ctx = NULL,
  };

  if (httpd_start(&cameraHttpd, &config) == ESP_OK) {
    httpd_register_uri_handler(cameraHttpd, &streamUri);
    Serial.println("[HTTP] Stream at http://" + WiFi.localIP().toString() + "/stream");
  } else {
    Serial.println("[HTTP] Server start failed");
  }
}

// ── Topics ────────────────────────────────────────────────────────────────────

void buildTopicsFromMAC() {
  String mac = WiFi.macAddress();
  mac.toLowerCase();
  mac.replace(":", "");

  announceTopic = String(TOPIC_PREFIX) + mac;
  motorsTopic   = announceTopic + "/motors/command";
  clientId      = "esp32-cam-" + mac;

  // Include stream URL in announcement so the dashboard can show the feed
  String streamUrl = "http://" + WiFi.localIP().toString() + "/stream";
  announcement = "{\"topics\":[\"" + motorsTopic + "\"],\"stream\":\"" + streamUrl + "\"}";

  Serial.println("MQTT topic: " + motorsTopic);
}

// ── Motors ────────────────────────────────────────────────────────────────────

void setMotor(int ch, int pinA, int pinB, float speed) {
  speed = constrain(speed, -1.0f, 1.0f);
  int duty = (int)(fabsf(speed) * 255);

  if (speed > 0)       { digitalWrite(pinA, HIGH); digitalWrite(pinB, LOW);  }
  else if (speed < 0)  { digitalWrite(pinA, LOW);  digitalWrite(pinB, HIGH); }
  else                 { digitalWrite(pinA, LOW);  digitalWrite(pinB, LOW);  }

  ledcWrite(ch, duty);
}

void stopMotors() {
  setMotor(PWM_CH_L, IN1, IN2, 0);
  setMotor(PWM_CH_R, IN3, IN4, 0);
}

void setupMotors() {
  ledcSetup(PWM_CH_L, PWM_FREQ, PWM_RES);
  ledcAttachPin(ENA, PWM_CH_L);
  ledcSetup(PWM_CH_R, PWM_FREQ, PWM_RES);
  ledcAttachPin(ENB, PWM_CH_R);

  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);

  stopMotors();
}

// ── MQTT message handler ──────────────────────────────────────────────────────

void onMessage(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, motorsTopic.c_str()) != 0) return;

  char buf[length + 1];
  memcpy(buf, payload, length);
  buf[length] = '\0';

  float left = 0, right = 0;
  const char* lp = strstr(buf, "\"left\"");
  const char* rp = strstr(buf, "\"right\"");
  if (lp) sscanf(lp + sizeof("\"left\"")  - 1, " :%f", &left);
  if (rp) sscanf(rp + sizeof("\"right\"") - 1, " :%f", &right);

  setMotor(PWM_CH_L, IN1, IN2, left);
  setMotor(PWM_CH_R, IN3, IN4, right);
  lastCommandMs = millis();
}

// ── OTA ───────────────────────────────────────────────────────────────────────

void setupOTA() {
  ArduinoOTA.setHostname("esp32-cam-video");
  ArduinoOTA.onStart([]() {
    stopMotors();
    mqttClient.disconnect();
    if (cameraHttpd) httpd_stop(cameraHttpd);
    Serial.println("OTA start");
  });
  ArduinoOTA.onEnd([]()   { Serial.println("OTA done"); });
  ArduinoOTA.onError([](ota_error_t e) { Serial.printf("OTA error [%u]\n", e); });
  ArduinoOTA.begin();
}

// ── MQTT reconnect ────────────────────────────────────────────────────────────

void mqttReconnect() {
  static unsigned long lastAttemptMs = 0;
  unsigned long now = millis();
  if (now - lastAttemptMs < RECONNECT_INTERVAL_MS) return;
  lastAttemptMs = now;

  Serial.print("Connecting to MQTT...");
  if (!mqttClient.connect(clientId.c_str())) {
    Serial.print(" failed, rc=");
    Serial.println(mqttClient.state());
    return;
  }

  Serial.println(" connected (" + String(MQTT_IP) + ")");
  mqttClient.publish(announceTopic.c_str(), announcement.c_str(), true);
  mqttClient.subscribe(motorsTopic.c_str());
}

// ── Setup / loop ──────────────────────────────────────────────────────────────

void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
  Serial.begin(115200);
  delay(2000);

  setupMotors();

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setTxPower(WIFI_POWER_8_5dBm);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());

  if (setupCamera()) startCameraServer();

  buildTopicsFromMAC();
  setupOTA();

  mqttClient.setServer(MQTT_IP, MQTT_PORT);
  mqttClient.setCallback(onMessage);
}

void loop() {
  ArduinoOTA.handle();

  if (mqttClient.connected()) {
    mqttClient.loop();
    if (lastCommandMs > 0 && millis() - lastCommandMs > COMMAND_TIMEOUT_MS) {
      stopMotors();
      lastCommandMs = 0;
    }
  } else {
    stopMotors();
    mqttReconnect();
  }
}
