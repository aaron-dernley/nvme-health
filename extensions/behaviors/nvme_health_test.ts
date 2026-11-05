// Run with `deno test -A`. Most tests stub nvme-cli and sysfs through the
// methods' injectable `_run` runner, using JSON captured from a real
// BIWIN CE430T5D100-512G on a Raspberry Pi 5. One test reads the real
// hwmon temperatures and is skipped on hosts with no NVMe controller.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261030.68";
import {
  behavior,
  type CommandRunner,
  computeDeltas,
  controllerName,
  DATA_UNIT_BYTES,
  decodeCriticalWarning,
  kelvinToCelsius,
  parseErrorLog,
  parseIdCtrl,
  parseMillidegrees,
  parseSmartLog,
  toNumber,
} from "./nvme_health.ts";

// createModelTestContext() returns a context typed with a default
// Record<string, unknown> globalArgs; this cast bridges it to execute()'s
// own parameter type, as in the sibling @aaronge extensions' tests.
function asContext<T>(context: unknown): T {
  return context as T;
}

const GLOBAL_ARGS = {
  device: "/dev/nvme0",
  nvmePath: "nvme",
  useSudo: true,
  sudoPath: "sudo",
  sysfsNvmePath: "/sys/class/nvme",
};

/** `nvme smart-log /dev/nvme0 -o json`, captured 2026-11-05. */
const SMART_LOG = {
  critical_warning: 0,
  temperature: 322,
  avail_spare: 100,
  spare_thresh: 10,
  percent_used: 0,
  endurance_grp_critical_warning_summary: 0,
  data_units_read: 290847575,
  data_units_written: 12190587,
  host_read_commands: 3206384783,
  host_write_commands: 155524228,
  controller_busy_time: 191,
  power_cycles: 25,
  power_on_hours: 1443,
  unsafe_shutdowns: 16,
  media_errors: 0,
  num_err_log_entries: 0,
  warning_temp_time: 0,
  critical_comp_time: 0,
  temperature_sensor_1: 329,
  temperature_sensor_2: 322,
  thm_temp1_trans_count: 0,
  thm_temp2_trans_count: 0,
  thm_temp1_total_time: 0,
  thm_temp2_total_time: 0,
};

/** The fields this behavior reads from `nvme id-ctrl /dev/nvme0 -o json`. */
const ID_CTRL = {
  mn: "BIWIN CE430T5D100-512G                  ",
  sn: "SN-EXAMPLE-0001     ",
  fr: "1.4.7.70",
  wctemp: 358,
  cctemp: 360,
  tnvmcap: 512110190592,
  oacs: 23,
  apsta: 1,
  npss: 4,
};

const EMPTY_ERROR = {
  error_count: 0,
  sqid: 0,
  cmdid: 0,
  status_field: 0,
  phase_tag: 0,
  parm_error_location: 0,
  lba: 0,
  nsid: 0,
  vs: 0,
  trtype: 0,
  cs: 0,
  trtype_spec_info: 0,
};

/** A stub runner that answers from a map and records every call. */
function stubRunner(responses: Record<string, string>) {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    const match = Object.keys(responses).find((k) => key.includes(k));
    if (match === undefined) {
      return Promise.reject(new Error(`unexpected command: ${key}`));
    }
    return Promise.resolve(responses[match]);
  };
  return { run, calls };
}

// --- pure helpers --------------------------------------------------------

Deno.test("toNumber accepts numbers and numeric strings, nothing else", () => {
  assertEquals(toNumber(42), 42);
  assertEquals(toNumber("12190587"), 12190587);
  assertEquals(toNumber(" 7 "), 7);
  assertEquals(toNumber("0x10"), null);
  assertEquals(toNumber(undefined), null);
  assertEquals(toNumber(Number.NaN), null);
});

Deno.test("kelvinToCelsius uses the NVMe 273 offset and treats 0 as unreported", () => {
  assertEquals(kelvinToCelsius(322), 49);
  assertEquals(kelvinToCelsius(0), null);
  assertEquals(kelvinToCelsius(null), null);
});

Deno.test("decodeCriticalWarning names each bit", () => {
  assertEquals(decodeCriticalWarning(0), {
    spareBelowThreshold: false,
    temperatureOutOfRange: false,
    reliabilityDegraded: false,
    readOnly: false,
    volatileBackupFailed: false,
    persistentMemoryReadOnly: false,
  });
  const flags = decodeCriticalWarning(0b001101);
  assert(flags.spareBelowThreshold);
  assert(!flags.temperatureOutOfRange);
  assert(flags.reliabilityDegraded);
  assert(flags.readOnly);
});

Deno.test("controllerName accepts only controller nodes", () => {
  assertEquals(controllerName("/dev/nvme0"), "nvme0");
  assertEquals(controllerName("/dev/nvme12"), "nvme12");
  for (const bad of ["/dev/nvme0n1", "/dev/sda", "/dev/nvme0; rm -rf /", "nvme0"]) {
    assertThrows(() => controllerName(bad), Error, "controller node");
  }
});

Deno.test("parseMillidegrees converts hwmon values", () => {
  assertEquals(parseMillidegrees("47850\n"), 47.85);
  assertEquals(parseMillidegrees("n/a"), null);
});

// --- parseSmartLog -------------------------------------------------------

Deno.test("parseSmartLog converts units, temperatures and counters", () => {
  const smart = parseSmartLog(SMART_LOG);
  assertEquals(smart.criticalWarning, 0);
  assertEquals(smart.temperatureCelsius, 49);
  assertEquals(smart.sensorTemperaturesCelsius, [56, 49]);
  assertEquals(smart.availableSparePercent, 100);
  assertEquals(smart.spareThresholdPercent, 10);
  assertEquals(smart.percentUsed, 0);
  assertEquals(smart.bytesWritten, 12190587 * DATA_UNIT_BYTES);
  assertEquals(smart.bytesRead, 290847575 * DATA_UNIT_BYTES);
  assertEquals(smart.unsafeShutdowns, 16);
  assertEquals(smart.thermalThrottleHeavySeconds, 0);
});

Deno.test("parseSmartLog degrades optional fields to null, never 0", () => {
  const smart = parseSmartLog({
    critical_warning: 0,
    avail_spare: 100,
    spare_thresh: 10,
    percent_used: 3,
  });
  assertEquals(smart.mediaErrors, null);
  assertEquals(smart.temperatureCelsius, null);
  assertEquals(smart.sensorTemperaturesCelsius, []);
});

Deno.test("parseSmartLog throws when an assert-critical field is missing", () => {
  const { critical_warning: _omit, ...rest } = SMART_LOG;
  assertThrows(() => parseSmartLog(rest), Error, "critical_warning");
  assertThrows(() => parseSmartLog("nope"), Error, "not a JSON object");
});

// --- computeDeltas -------------------------------------------------------

Deno.test("computeDeltas is all null on the first reading", () => {
  const deltas = computeDeltas(parseSmartLog(SMART_LOG), "2026-11-05T12:00:00Z", null);
  assertEquals(Object.values(deltas).every((v) => v === null), true);
});

Deno.test("computeDeltas reports increases and a daily write rate", () => {
  const before = parseSmartLog(SMART_LOG);
  const after = parseSmartLog({
    ...SMART_LOG,
    unsafe_shutdowns: 17,
    data_units_written: SMART_LOG.data_units_written + 100,
  });
  const deltas = computeDeltas(after, "2026-11-05T12:15:00Z", {
    capturedAt: "2026-11-05T12:00:00Z",
    counters: before,
  });
  assertEquals(deltas.intervalSeconds, 900);
  assertEquals(deltas.unsafeShutdowns, 1);
  assertEquals(deltas.mediaErrors, 0);
  assertEquals(deltas.bytesWritten, 100 * DATA_UNIT_BYTES);
  assertEquals(deltas.writeBytesPerDay, 100 * DATA_UNIT_BYTES * 96);
});

Deno.test("computeDeltas skips the write rate for readings too close together", () => {
  const before = parseSmartLog(SMART_LOG);
  const after = parseSmartLog({ ...SMART_LOG, data_units_written: SMART_LOG.data_units_written + 1 });
  const deltas = computeDeltas(after, "2026-11-05T12:00:07Z", {
    capturedAt: "2026-11-05T12:00:00Z",
    counters: before,
  });
  assertEquals(deltas.bytesWritten, DATA_UNIT_BYTES);
  assertEquals(deltas.writeBytesPerDay, null);
});

Deno.test("computeDeltas yields null, not a negative, when a counter goes down", () => {
  const before = parseSmartLog(SMART_LOG);
  const swapped = parseSmartLog({ ...SMART_LOG, power_cycles: 1, media_errors: 0 });
  const deltas = computeDeltas(swapped, "2026-11-05T12:15:00Z", {
    capturedAt: "2026-11-05T12:00:00Z",
    counters: { ...before, mediaErrors: 5 },
  });
  assertEquals(deltas.mediaErrors, null);
});

// --- parseErrorLog / parseIdCtrl ------------------------------------------

Deno.test("parseErrorLog drops the zero-filled unused slots", () => {
  assertEquals(parseErrorLog({ errors: [EMPTY_ERROR, EMPTY_ERROR] }), []);
  const entries = parseErrorLog({
    errors: [{ ...EMPTY_ERROR, error_count: 3, status_field: 0x281, lba: 1024 }, EMPTY_ERROR],
  });
  assertEquals(entries.length, 1);
  assertEquals(entries[0].errorCount, 3);
  assertEquals(entries[0].lba, 1024);
  assertThrows(() => parseErrorLog({}), Error, "errors");
});

Deno.test("parseIdCtrl reads thresholds and capability bits", () => {
  assertEquals(parseIdCtrl(ID_CTRL), {
    capacityBytes: 512110190592,
    warningTempCelsius: 85,
    criticalTempCelsius: 87,
    apstSupported: true,
    powerStates: 5,
    selfTestSupported: true,
  });
  assertEquals(parseIdCtrl(null).capacityBytes, null);
});

// --- methods (stubbed) ---------------------------------------------------

Deno.test("readSmart runs nvme via sudo -n and records deltas against stored data", async () => {
  const before = parseSmartLog(SMART_LOG);
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "readSmart",
    storedResources: {
      smart: { capturedAt: new Date(Date.now() - 900_000).toISOString(), counters: before },
    },
  });
  const { run, calls } = stubRunner({
    "smart-log": JSON.stringify({ ...SMART_LOG, media_errors: 2 }),
  });

  await behavior.methods.readSmart.execute({ _run: run }, asContext(context));

  assertEquals(calls[0], ["sudo", "-n", "nvme", "smart-log", "/dev/nvme0", "-o", "json"]);
  const data = getWrittenResources()[0].data as {
    criticalWarningFlags: { readOnly: boolean };
    counters: Record<string, number | null>;
    deltas: { mediaErrors: number | null; intervalSeconds: number | null };
  };
  assertEquals(getWrittenResources()[0].specName, "smart");
  assertEquals(data.criticalWarningFlags.readOnly, false);
  assertEquals(data.counters.mediaErrors, 2);
  assertEquals(data.deltas.mediaErrors, 2);
  assert(data.deltas.intervalSeconds !== null && data.deltas.intervalSeconds > 0);
});

Deno.test("readSmart calls nvme directly when useSudo is false", async () => {
  const { context } = createModelTestContext({
    globalArgs: { ...GLOBAL_ARGS, useSudo: false },
    methodName: "readSmart",
  });
  const { run, calls } = stubRunner({ "smart-log": JSON.stringify(SMART_LOG) });
  await behavior.methods.readSmart.execute({ _run: run }, asContext(context));
  assertEquals(calls[0][0], "nvme");
});

Deno.test("readSmart refuses a device that isn't a controller node", async () => {
  const { context } = createModelTestContext({
    globalArgs: { ...GLOBAL_ARGS, device: "/dev/nvme0n1" },
    methodName: "readSmart",
  });
  const { run, calls } = stubRunner({});
  await assertRejects(
    () => behavior.methods.readSmart.execute({ _run: run }, asContext(context)),
    Error,
    "controller node",
  );
  assertEquals(calls.length, 0);
});

Deno.test("readTemperature reads every hwmon sensor and hoists Composite", async () => {
  const hw = "/sys/class/nvme/nvme0/hwmon1";
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "readTemperature",
  });
  const { run } = stubRunner({
    "ls /sys/class/nvme/nvme0/hwmon1": "name temp1_alarm temp1_crit temp1_input temp1_label temp1_max temp2_input temp2_label",
    "ls /sys/class/nvme/nvme0": "address hwmon1 model nvme0n1",
    [`${hw}/temp1_input`]: "47850\n",
    [`${hw}/temp1_label`]: "Composite\n",
    [`${hw}/temp1_max`]: "84850\n",
    [`${hw}/temp1_crit`]: "86850\n",
    [`${hw}/temp1_alarm`]: "0\n",
    [`${hw}/temp2_input`]: "55850\n",
    [`${hw}/temp2_label`]: "Sensor 1\n",
  });

  await behavior.methods.readTemperature.execute({ _run: run }, asContext(context));

  const data = getWrittenResources()[0].data as {
    compositeCelsius: number;
    alarm: boolean;
    sensors: Array<{ label: string; celsius: number; maxCelsius: number | null }>;
  };
  assertEquals(data.compositeCelsius, 47.85);
  assertEquals(data.alarm, false);
  assertEquals(data.sensors.map((s) => s.label), ["Composite", "Sensor 1"]);
  assertEquals(data.sensors[0].maxCelsius, 84.85);
  assertEquals(data.sensors[1].maxCelsius, null);
});

Deno.test("readIdentity keeps sysfs fields when id-ctrl can't run", async () => {
  const ctrl = "/sys/class/nvme/nvme0";
  const { context, getWrittenResources, getLogsByLevel } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "readIdentity",
  });
  const { run } = stubRunner({
    [`${ctrl}/model`]: "BIWIN CE430T5D100-512G                  \n",
    [`${ctrl}/serial`]: "SN-EXAMPLE-0001     \n",
    [`${ctrl}/firmware_rev`]: "1.4.7.70\n",
    [`${ctrl}/state`]: "live\n",
    [`${ctrl}/transport`]: "pcie\n",
    [`${ctrl}/address`]: "0001:01:00.0\n",
  });

  await behavior.methods.readIdentity.execute({ _run: run }, asContext(context));

  const data = getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(data.model, "BIWIN CE430T5D100-512G");
  assertEquals(data.serial, "SN-EXAMPLE-0001");
  assertEquals(data.address, "0001:01:00.0");
  assertEquals(data.capacityBytes, null);
  assertEquals(getLogsByLevel("warning").length, 1);
});

Deno.test("readSmart explains output that isn't JSON", async () => {
  const { context } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "readSmart",
  });
  const { run } = stubRunner({ "smart-log": "Smart Log for NVME device:nvme0" });
  await assertRejects(
    () => behavior.methods.readSmart.execute({ _run: run }, asContext(context)),
    Error,
    "did not return JSON",
  );
});

Deno.test("readErrorLog writes only real entries", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "readErrorLog",
  });
  const { run } = stubRunner({
    "error-log": JSON.stringify({ errors: [EMPTY_ERROR, EMPTY_ERROR] }),
  });
  await behavior.methods.readErrorLog.execute({ _run: run }, asContext(context));
  const data = getWrittenResources()[0].data as { entryCount: number };
  assertEquals(data.entryCount, 0);
});

// --- real hardware -------------------------------------------------------

const hasNvme = await Deno.stat("/sys/class/nvme/nvme0").then(() => true, () => false);

Deno.test({
  name: "readTemperature reads real hwmon temperatures without root",
  ignore: !hasNvme,
  fn: async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
      methodName: "readTemperature",
    });
    await behavior.methods.readTemperature.execute({}, asContext(context));
    const data = getWrittenResources()[0].data as {
      compositeCelsius: number | null;
      sensors: unknown[];
    };
    assert(data.sensors.length > 0);
    assert(
      data.compositeCelsius !== null && data.compositeCelsius > 0 &&
        data.compositeCelsius < 100,
      `implausible composite temperature: ${data.compositeCelsius}`,
    );
  },
});
