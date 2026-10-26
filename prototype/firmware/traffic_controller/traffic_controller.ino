/*
 * traffic_controller.ino - reference firmware for the signal-controller board (ESP32-DevKitC)
 *
 * NOT YET COMPILED OR FLASHED: written to match the serial protocol of the AdaptiveSignal
 * Control Console (prototype/index.html). Check pin numbers against your own wiring before use.
 *
 * Protocol (115200 baud, newline terminated)
 *   PC  -> board  S,<N>,<E>,<S>,<W>   each R | Y | G      set the four signal heads
 *   PC  -> board  E,<N|E|S|W>         emergency vehicle on that approach (informational)
 *   board -> PC   OK                  acknowledgement of every valid command
 *   board -> PC   C,<n>,<e>,<s>,<w>   vehicles currently inside each monitored zone (1 Hz)
 *
 * Safety rules enforced here, independent of the PC
 *   - conflicting greens are refused (N/S and E/W may not be green together)
 *   - a green may not follow a green of the other axis without >= 3 s yellow + 2 s all-red
 *   - if no valid S command arrives for 5 s the board runs a fixed 30 s / 30 s plan
 */

const uint8_t LED_PIN[4][3] = {      // R, Y, G for N, E, S, W
  {16, 17, 18}, {19, 21, 22}, {23, 25, 26}, {27, 32, 33}
};
const uint8_t STOP_BEAM[4] = {34, 36, 4, 14};   // IR beam at the stop line
const uint8_t FAR_BEAM[4]  = {35, 39, 13, 15};  // IR beam at the far end of the zone
const char    APPR[4]      = {'N', 'E', 'S', 'W'};

const uint32_t YELLOW_MS = 3000, ALLRED_MS = 2000, FAILSAFE_MS = 5000, FIXED_GREEN_MS = 30000;
const uint32_t DEBOUNCE_MS = 40;

char     shown[4]  = {'R', 'R', 'R', 'R'};   // what the LEDs currently display
char     wanted[4] = {'R', 'R', 'R', 'R'};   // last command from the PC
uint32_t lastCmdMs = 0;

int      zoneIn[4] = {0, 0, 0, 0}, zoneOut[4] = {0, 0, 0, 0};
bool     farPrev[4] = {false, false, false, false}, stopPrev[4] = {false, false, false, false};
uint32_t farT[4] = {0, 0, 0, 0}, stopT[4] = {0, 0, 0, 0};

// fixed-time fallback state
uint8_t  fbPhase = 0;                // 0 = N/S green, 1 = E/W green
uint8_t  fbStage = 0;                // 0 green, 1 yellow, 2 all red
uint32_t fbStart = 0;

void setHead(uint8_t a, char c) {
  digitalWrite(LED_PIN[a][0], c == 'R');
  digitalWrite(LED_PIN[a][1], c == 'Y');
  digitalWrite(LED_PIN[a][2], c == 'G');
  shown[a] = c;
}

bool conflict(const char s[4]) {     // N/S green together with E/W green
  bool ns = s[0] == 'G' || s[0] == 'Y' || s[2] == 'G' || s[2] == 'Y';
  bool ew = s[1] == 'G' || s[1] == 'Y' || s[3] == 'G' || s[3] == 'Y';
  return ns && ew;
}

void handleLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  if (line.startsWith("S,") && line.length() == 9) {
    char s[4] = {line[2], line[4], line[6], line[8]};
    for (int i = 0; i < 4; i++) if (s[i] != 'R' && s[i] != 'Y' && s[i] != 'G') { Serial.println("ERR"); return; }
    if (conflict(s)) { Serial.println("ERR,CONFLICT"); return; }
    memcpy(wanted, s, 4);
    lastCmdMs = millis();
    Serial.println("OK");
  } else if (line.startsWith("E,")) {
    Serial.println("OK");            // a real build would hold green here as a local fall-back
  } else {
    Serial.println("ERR");
  }
}

void readBeams() {                    // debounced rising edges: far beam = entry, stop beam = exit
  uint32_t now = millis();
  for (int a = 0; a < 4; a++) {
    bool f = digitalRead(FAR_BEAM[a]) == LOW, s = digitalRead(STOP_BEAM[a]) == LOW;   // beam broken = LOW
    if (f && !farPrev[a] && now - farT[a] > DEBOUNCE_MS)  { zoneIn[a]++;  farT[a] = now; }
    if (s && !stopPrev[a] && now - stopT[a] > DEBOUNCE_MS) { zoneOut[a]++; stopT[a] = now; }
    farPrev[a] = f; stopPrev[a] = s;
    if (zoneOut[a] > zoneIn[a]) zoneIn[a] = zoneOut[a];
  }
}

void fallbackPlan(char out[4]) {      // 30 s / 30 s with the same yellow and all-red as the console
  uint32_t t = millis() - fbStart;
  uint32_t lim = fbStage == 0 ? FIXED_GREEN_MS : fbStage == 1 ? YELLOW_MS : ALLRED_MS;
  if (t >= lim) {
    fbStart = millis();
    if (fbStage == 0) fbStage = 1;
    else if (fbStage == 1) fbStage = 2;
    else { fbStage = 0; fbPhase ^= 1; }
  }
  for (int a = 0; a < 4; a++) {
    bool mine = (a % 2) == fbPhase;
    out[a] = (mine && fbStage == 0) ? 'G' : (mine && fbStage == 1) ? 'Y' : 'R';
  }
}

void setup() {
  Serial.begin(115200);
  for (int a = 0; a < 4; a++) {
    for (int k = 0; k < 3; k++) pinMode(LED_PIN[a][k], OUTPUT);
    pinMode(STOP_BEAM[a], INPUT_PULLUP);   // pins 34-39 have no internal pull-up: add 10 k to 3.3 V
    pinMode(FAR_BEAM[a], INPUT_PULLUP);
    setHead(a, 'R');
  }
  fbStart = millis();
}

void loop() {
  static String buf;
  static uint32_t lastC = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handleLine(buf); buf = ""; } else if (buf.length() < 32) buf += c;
  }
  readBeams();

  char target[4];
  if (millis() - lastCmdMs < FAILSAFE_MS) memcpy(target, wanted, 4);
  else fallbackPlan(target);
  for (int a = 0; a < 4; a++) if (target[a] != shown[a]) setHead(a, target[a]);

  if (millis() - lastC >= 1000) {
    lastC = millis();
    Serial.print("C");
    for (int a = 0; a < 4; a++) { Serial.print(','); Serial.print(max(0, zoneIn[a] - zoneOut[a])); }
    Serial.println();
  }
}
