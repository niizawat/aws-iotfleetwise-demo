#include "Arduino.h"
#include "SPI.h"
#include "mcp2515.h"

const int LED_PIN = 7;
const int CANBUS_PIN = 10;

// 送信メッセージ格納用
struct can_frame canMsg;
// CANコントローラに接続したPIN番号でインスタンス初期化
MCP2515 mcp2515(CANBUS_PIN);

void setup()
{
  // LED接続PINの設定
  pinMode(LED_PIN, OUTPUT);

  while (!Serial);
  Serial.begin(9600);
  SPI.begin();

  // CANインターフェースの初期化
  mcp2515.reset();
  // ビットレート1Mbos, クロック8MHz
  mcp2515.setBitrate(CAN_1000KBPS, MCP_8MHZ);
  // CANをノーマルモードに設定
  mcp2515.setNormalMode();
}

// the loop function runs over and over again forever
void loop()
{
  uint16_t cds_raw; // アナログピンから読んだ光センサーの値
  uint16_t cds_pct; // 明るさ(0.00〜100.00%を整数で持つ(0〜10000))
  uint8_t led; // LEDの点灯フラグ(HIGH: On, LOW: Off)

  cds_raw = analogRead(A6);
  cds_pct = float(cds_raw) / 1023.0 * 100.0 * 100.0; // 100倍して小数第２位までを整数に変換

  // 明るさ50%未満でLED On
  if (cds_pct < 5000)
  {
    led = HIGH; // ON
  }
  else
  {
    led = LOW; // OFF
  }
  digitalWrite(LED_PIN, led);

  Serial.println("cds_raw=" + String(cds_raw) + "; cds_pct=" + String(cds_pct) + "; led=" + String(led) + ";");

  // CANにデータを送信
  // Vehicle.Exterior.LightIntensity
  canMsg.can_id = 0x001; // CAN ID: 1
  canMsg.can_dlc = 2; // CANデータ長2バイト
  memcpy(canMsg.data, &cds_pct, 2);
  // canMsg.data[0] = lowByte(cds_pct);
  // canMsg.data[1] = highByte(cds_pct);
  mcp2515.sendMessage(&canMsg);

  // Vehicle.Body.Lights.Beam.Low.IsOn
  canMsg.can_id = 0x002; // CAN ID: 2
  canMsg.can_dlc = 1;    // CANデータ長1バイト
  canMsg.data[0] = led;
  mcp2515.sendMessage(&canMsg);

  delay(500);
}
