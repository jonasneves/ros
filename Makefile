.DEFAULT_GOAL := help

-include config.mk

FQBN      ?= esp32:esp32:esp32cam:PartitionScheme=default
PORT      ?= $(shell ls /dev/cu.usbserial-* 2>/dev/null | head -1)
MQTT_IP   ?= broker.hivemq.com
ESP32_IP  ?=
SKETCH    ?= esp32_led
BUILD_DIR := /tmp/esp32-$(SKETCH)-build
ESPOTA    := $(shell find ~/Library/Arduino15/packages/esp32 -name espota.py 2>/dev/null | sort -V | tail -1)
MONITOR    = arduino-cli monitor --port "$(PORT)" --config baudrate=115200,dtr=off,rts=off

# Outer single quotes pass the whole expression to the shell as one word;
# inner double quotes produce C string literals for the -D defines.
BUILD_FLAGS := 'build.extra_flags=-DWIFI_SSID="$(strip $(WIFI_SSID))" -DWIFI_PASS="$(strip $(WIFI_PASS))" -DMQTT_IP="$(strip $(MQTT_IP))"'

.PHONY: help setup mqtt preview proxy compile flash ota monitor flash-monitor flash-car ota-car flash-cam-video ota-cam-video

help:
	@echo ""
	@echo "\033[2mSetup\033[0m"
	@echo "  \033[36msetup\033[0m          Install host dependencies (run once per machine)"
	@echo ""
	@echo "\033[2mDev\033[0m"
	@echo "  \033[36mmqtt\033[0m           Start local Mosquitto broker (optional. Cloud broker used by default)"
	@echo "  \033[36mpreview\033[0m        Serve dashboard at http://localhost:8080"
	@echo "  \033[36mproxy\033[0m          Start local Claude proxy (personal account, port 7337)"
	@echo ""
	@echo "\033[2mFirmware — LED (default)\033[0m"
	@echo "  \033[36mflash\033[0m          Compile + upload esp32_led over USB"
	@echo "  \033[36mota\033[0m            Compile + upload esp32_led over WiFi (set ESP32_IP in config.mk)"
	@echo "  \033[36mmonitor\033[0m        Open serial monitor"
	@echo "  \033[36mflash-monitor\033[0m  flash + open serial monitor"
	@echo ""
	@echo "\033[2mFirmware — Car (motor control)\033[0m"
	@echo "  \033[36mflash-car\033[0m          Compile + upload esp32_car over USB"
	@echo "  \033[36mota-car\033[0m            Compile + upload esp32_car over WiFi"
	@echo ""
	@echo "\033[2mFirmware — Car + Camera (MJPEG stream)\033[0m"
	@echo "  \033[36mflash-cam-video\033[0m    Compile + upload esp32_cam_video over USB"
	@echo "  \033[36mota-cam-video\033[0m      Compile + upload esp32_cam_video over WiFi"
	@echo ""
	@echo "  Any target accepts \033[36mSKETCH=<name>\033[0m to select a firmware sketch."
	@echo ""

setup:
	@echo "Installing host dependencies..."
	@echo ""
	@echo "1/2 Installing CP210x USB driver (enables ESP32 USB connection)..."
	brew install --cask silicon-labs-vcp-driver
	@echo ""
	@echo "2/2 Installing arduino-cli (for firmware compilation and upload)..."
	brew install arduino-cli
	arduino-cli core update-index
	arduino-cli core install esp32:esp32
	arduino-cli lib install "PubSubClient"
	@echo ""
	@echo "Done. After install, macOS may prompt you to allow the driver in"
	@echo "System Preferences > Privacy & Security. Do that before running make flash."

mqtt:
	@echo "Local MQTT broker: mqtt://localhost:1883"
	@echo "Local WebSocket:   ws://localhost:9001"
	@echo "To use locally, set in config.mk:"
	@echo "  MQTT_IP = $$(ipconfig getifaddr en0)"
	@echo ""
	docker compose -f docker/docker-compose.yml up mqtt

preview:
	@printf "\n\033[1;36m  Dashboard: http://localhost:8080\033[0m\n\n"
	python3 -m http.server 8080 --directory dashboard

proxy:
	@printf "\n\033[1;36m  Claude proxy: http://127.0.0.1:7337\033[0m\n\n"
	node local-proxy.js

compile:
	@echo "Compiling firmware/$(SKETCH)..."
	@arduino-cli compile \
		--fqbn "$(FQBN)" \
		--build-property $(BUILD_FLAGS) \
		--build-path "$(BUILD_DIR)" \
		firmware/$(SKETCH)

flash: compile
	@echo "Uploading over USB..."
	@arduino-cli upload \
		--fqbn "$(FQBN)" \
		--port "$(PORT)" \
		--input-dir "$(BUILD_DIR)" \
		firmware/$(SKETCH)

ota: compile
	@test -n "$(ESP32_IP)" || (echo "Error: set ESP32_IP in config.mk (shown in Serial Monitor after boot)"; exit 1)
	@test -n "$(ESPOTA)"   || (echo "Error: espota.py not found — run make setup"; exit 1)
	@echo "Uploading over WiFi to $(ESP32_IP)..."
	@python3 "$(ESPOTA)" -i "$(ESP32_IP)" -f "$(BUILD_DIR)/$(SKETCH).ino.bin"

flash-car:
	$(MAKE) flash SKETCH=esp32_car

ota-car:
	$(MAKE) ota SKETCH=esp32_car

flash-cam-video:
	$(MAKE) flash SKETCH=esp32_cam_video

ota-cam-video:
	$(MAKE) ota SKETCH=esp32_cam_video

monitor:
	$(MONITOR)

flash-monitor: flash
	@echo "Waiting for ESP32 to boot..."
	@sleep 2
	$(MONITOR)
