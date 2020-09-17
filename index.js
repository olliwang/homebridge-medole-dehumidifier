const mqtt = require('mqtt');

var Service, Characteristic;

module.exports = function(homebridge) {
  Characteristic = homebridge.hap.Characteristic;
  Service = homebridge.hap.Service;

  homebridge.registerAccessory("homebridge-medole-dehumidifier",
                               "MedoleDehumidifier",
                               MedoleDehumidifier);
}

function MedoleDehumidifier(log, config) {
  function boolValueWithDefault(value, defaultValue) {
    if (value == undefined) {
      return defaultValue;
    } else {
      return value;
    }
  }

  this.debug = boolValueWithDefault(config.debug, false);
  this.password = config.password;
  this.token = config.token;
  this.name = config.name || 'Medole Dehumidifier';
  this.displayName = config.name;
  this.showsTemperature = boolValueWithDefault(config.showsTemperature, false);

  this.services = [];

  if (!this.password) {
    throw new Error('You must provide your Medole password.');
  }

  if (!this.token) {
    throw new Error('You must provide your Medole token.');
  }

  const TOPIC_PREFIX = 'MEDOLE/MEDOLE/' + this.token + '/';
  this.RAW_TOPIC = TOPIC_PREFIX + 'raw';
  this.REQ_TOPIC = TOPIC_PREFIX + 'req';

  this.connectedMqtt = false;
  this.currentHumidity = undefined;
  this.currentTemperature = undefined;
  this.fanSpeed = undefined;
  this.isActive = undefined;
  this.targetHumidity = undefined;

  this.minHumidityValue = 30;
  this.maxHumidityValue = 90;

  this.mqttClient = mqtt.connect('mqtt://54.178.141.153', {
    port: 1883,
    username: 'medole',
    password: this.password
  });

  this.mqttClient.on('connect', function() {
    this.connectedMqtt = true;
    console.log('[MedoleDehumidifier] Connected to MedoleDehumidifier MQTT server.');

    this.mqttClient.subscribe(this.RAW_TOPIC, function() {
      this.mqttClient.on('message', function(topic, message, packet) {
        var json;
        try {
          json = JSON.parse(message);
        } catch (err) {
          console.error(err);
        } finally {
          this.currentHumidity = json['H'][0];
          this.currentTemperature = json['T'][0];
          this.fanSpeed = json['FAN'];
          this.isActive = json['POWER'][0];
          this.targetHumidity = json['HUMIDITY'];
        }
      }.bind(this));
    }.bind(this));
  }.bind(this));
}

MedoleDehumidifier.prototype = {
  getHumidityCode: function(humidity) {
    if (humidity < this.minHumidityValue) {
      humidity = this.minHumidityValue;
    } else if (humidity > this.maxHumidityValue) {
      humidity = this.maxHumidityValue;
    }

    var diff = humidity - this.minHumidityValue;
    var code = '550184';
    code += (0x1e + diff).toString(16);
    code += '00';

    const ranges = [[32, 47, 0xf0], [64, 79, 0x90], [80, 90, 0x80],
                    [this.minHumidityValue, this.maxHumidityValue, 0xce]];

    for (let range of ranges) {
      var start = range[2];

      if (humidity >= range[0] && humidity <= range[1]) {
        diff = humidity - range[0];
        break;
      }
    }
    code += (start + diff).toString(16);
    return code;
  },

  getServices: function() {
    var services = [];

    var infoService = new Service.AccessoryInformation();
    infoService
        .setCharacteristic(Characteristic.Manufacturer, "Medole")
        .setCharacteristic(Characteristic.Model, "Dehumidifier")
    services.push(infoService);

    var dehumidifierService = new Service.HumidifierDehumidifier(this.name);

    var currentHumidityCharacteristic = dehumidifierService.getCharacteristic(
        Characteristic.CurrentRelativeHumidity);

    var currentHumidifierDehumidifierStateCharacteristic =
        dehumidifierService.getCharacteristic(
            Characteristic.CurrentHumidifierDehumidifierState);

    var targetHumidifierDehumidifierStateCharacteristic =
        dehumidifierService.getCharacteristic(
            Characteristic.TargetHumidifierDehumidifierState);
    targetHumidifierDehumidifierStateCharacteristic.setProps({
      validValues: [2]
    });
    targetHumidifierDehumidifierStateCharacteristic.setValue(
      Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER);

    var activeCharacteristic =
        dehumidifierService.getCharacteristic(Characteristic.Active);

    var rotationSpeedCharacteristic =
        dehumidifierService.getCharacteristic(Characteristic.RotationSpeed);
    rotationSpeedCharacteristic.setProps({
      minValue: 0,
      maxValue: 3,
      minStep: 1,
    });

    activeCharacteristic
        .on('set', function(value, callback) {
          if (!this.connectedMqtt) {
            callback(new Error("Medole MQTT Server Not Yet Connected."));
            return;
          }
          this.mqttClient.publish(this.REQ_TOPIC,
                                  [value ? '5501810100d4' : '5501810000d5'],
                                  function() {
            callback(null);
          });
        }.bind(this));

    dehumidifierService
        .getCharacteristic(Characteristic.RelativeHumidityDehumidifierThreshold)
        .setProps({
          minValue: this.minHumidityValue,
          maxValue: this.maxHumidityValue,
          minStep: 1,
        })
        .on('get', function(callback) {
          if (this.debug) {
            console.log('[MedoleDehumidifier][DEBUG] - Get RelativeHumidityDehumidifierThreshold');
          }
          if (this.isActive) {
            activeCharacteristic.updateValue(Characteristic.Active.ACTIVE);
            currentHumidifierDehumidifierStateCharacteristic.updateValue(
                Characteristic.CurrentHumidifierDehumidifierState
                    .DEHUMIDIFYING);
          } else {
            activeCharacteristic.updateValue(Characteristic.Active.INACTIVE);
            currentHumidifierDehumidifierStateCharacteristic.updateValue(
                Characteristic.CurrentHumidifierDehumidifierState.INACTIVE);
          }
          currentHumidityCharacteristic.updateValue(this.currentHumidity);
          rotationSpeedCharacteristic.updateValue(this.fanSpeed);
          callback(null, this.currentHumidity);
        }.bind(this))
        .on('set', function(value, callback) {
          if (this.debug) {
            console.log('[MedoleDehumidifier][DEBUG] - Set RelativeHumidityDehumidifierThreshold');
          }
          if (!this.connectedMqtt) {
            callback(new Error("Mqtt Not Connected."));
            return;
          }
          this.mqttClient.publish(this.REQ_TOPIC, getHumidityCode(value),
                                  function() {
            callback(null);
          });
        }.bind(this));

      rotationSpeedCharacteristic
          .on('get', function(callback) {
            if (this.debug) {
              console.log('[MedoleDehumidifier][DEBUG] - Get RotationSpeed');
            }
            if (this.fanSpeed == undefined) {
              callback(new Error("Medole MQTT Server Not Yet Connected."));
            } else {
              callback(null, this.fanSpeed);
            }
          }.bind(this))
          .on('set', function(value, callback) {
            if (this.debug) {
              console.log('[MedoleDehumidifier][DEBUG] - Set RotationSpeed');
            }
            if (!this.connectedMqtt) {
              callback(new Error("Mqtt Not Connected."));
              return;
            }
            var code;
            switch (value) {
              case 1:
                code = '5501850100d0';
                break;
              case 2:
                code = '5501850200d3';
                break;
              case 3:
                code = '5501850300d2';
                break;
            }
            this.mqttClient.publish(this.REQ_TOPIC, code, function() {
                callback(null);
            });
          }.bind(this));

      services.push(dehumidifierService);

      if (this.showsTemperature) {
        var temperatureSensorService = new Service.TemperatureSensor(
            "Medole Temperature Sensor");
        temperatureSensorService
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', function(callback) {
              if (this.debug) {
                console.log('[MedoleDehumidifier][DEBUG] - Get CurrentTemperature: ' + this.currentTemperature);
              }
              if (this.currentTemperature == undefined) {
                callback(new Error("Medole MQTT Server Not Yet Connected"))
              } else {
                callback(null, this.currentTemperature);
              }
            }.bind(this));
        services.push(temperatureSensorService);
      }

      return services;
  }
}