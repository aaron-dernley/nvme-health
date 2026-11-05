/**
 * NVMe drive health for any Linux host: the SMART/health log (wear, spare,
 * media errors, unsafe shutdowns, thermal throttling), controller identity,
 * hwmon temperatures and the error log, as typed, versioned data.
 *
 * The health log, error log and `id-ctrl` are admin commands that need root
 * (CAP_SYS_ADMIN) whatever the device node's permissions, so those reads go
 * through `nvme` from nvme-cli, via `sudo -n` by default (see the
 * `useSudo`/`sudoPath` global arguments). Identity strings and temperatures
 * come from sysfs and hwmon, which are world-readable, so
 * {@linkcode behavior.methods.readTemperature} needs no privileges at all.
 *
 * `readSmart` compares each reading with the previous version of its own
 * data (via `readResource`) and records deltas, so workflows can assert
 * "no NEW media errors / error-log entries / unsafe shutdowns" rather than
 * alarming forever on a lifetime counter that went up once.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** NVMe "data units" are thousands of 512-byte blocks (NVMe base spec). */
export const DATA_UNIT_BYTES = 512_000;

/** NVMe reports temperatures as integer Kelvin; the spec converts with 273. */
const KELVIN_OFFSET = 273;

/**
 * Shortest gap between readings that `writeBytesPerDay` is projected from.
 * Writes are bursty, so a rate scaled up from a few seconds is noise.
 */
export const MIN_RATE_INTERVAL_SECONDS = 300;

/** Only controller character devices are accepted, e.g. `/dev/nvme0`. */
const DEVICE_PATTERN = /^\/dev\/nvme[0-9]+$/;

/** Minimal logger shape methods depend on — matches `context.logger`. */
interface MinimalLogger {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
}

/** Runs a command and returns its stdout, throwing on a non-zero exit. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<string>;

/** Default {@linkcode CommandRunner}: a real subprocess, no shell. */
export const runCommand: CommandRunner = async (cmd, args) => {
  // nvme-cli and sysfs (via cat) have no swamp primitive. Arguments are an
  // array (no shell) and the device is validated first; see the README.
  // swamp-quality-ignore deno-command
  const output = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout);
};

/**
 * Read a sysfs file through `cat` rather than `Deno.readTextFile`: every
 * `/sys/class/nvme/*` entry is a symlink into `/sys/devices/...`, which
 * trips Deno's permission check into demanding `--allow-all` even though
 * the file is world-readable. Same workaround as `@aaronge/host-health`.
 */
async function catFile(run: CommandRunner, path: string): Promise<string> {
  return (await run("cat", [path])).trim();
}

/** Throw unless `device` is a controller node like `/dev/nvme0`. */
export function validateDevice(device: string): void {
  if (!DEVICE_PATTERN.test(device)) {
    throw new Error(
      `device must be an NVMe controller node like /dev/nvme0, got "${device}"`,
    );
  }
}

/** Controller name for sysfs paths: `/dev/nvme0` → `nvme0`. */
export function controllerName(device: string): string {
  validateDevice(device);
  return device.slice("/dev/".length);
}

/**
 * Coerce an nvme-cli JSON value to a number. nvme-cli prints most counters
 * as JSON numbers but some versions print 128-bit counters as strings.
 * Returns null for anything missing or non-numeric, never a guessed 0.
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[0-9]+(\.[0-9]+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** Convert an NVMe Kelvin reading to °C; 0 means "not reported" → null. */
export function kelvinToCelsius(kelvin: number | null): number | null {
  if (kelvin === null || kelvin <= 0) return null;
  return kelvin - KELVIN_OFFSET;
}

/** Decoded bits of the health log's critical_warning byte. */
export interface CriticalWarningFlags {
  /** Bit 0: available spare fell below the spare threshold. */
  spareBelowThreshold: boolean;
  /** Bit 1: a temperature is above an over- or below an under-threshold. */
  temperatureOutOfRange: boolean;
  /** Bit 2: reliability degraded by media or internal errors. */
  reliabilityDegraded: boolean;
  /** Bit 3: media placed in read-only mode. */
  readOnly: boolean;
  /** Bit 4: volatile memory backup device failed. */
  volatileBackupFailed: boolean;
  /** Bit 5: persistent memory region became read-only. */
  persistentMemoryReadOnly: boolean;
}

/** Decode the critical_warning bitfield into named flags. */
export function decodeCriticalWarning(bits: number): CriticalWarningFlags {
  return {
    spareBelowThreshold: (bits & 0x01) !== 0,
    temperatureOutOfRange: (bits & 0x02) !== 0,
    reliabilityDegraded: (bits & 0x04) !== 0,
    readOnly: (bits & 0x08) !== 0,
    volatileBackupFailed: (bits & 0x10) !== 0,
    persistentMemoryReadOnly: (bits & 0x20) !== 0,
  };
}

/** The counters parsed from `nvme smart-log -o json`, before deltas. */
export interface SmartCounters {
  /** Raw critical_warning byte. */
  criticalWarning: number;
  /** Endurance group critical warning summary byte. */
  enduranceGroupCriticalWarning: number | null;
  /** Composite temperature in °C. */
  temperatureCelsius: number | null;
  /** Per-sensor temperatures in °C (sensor 1 first); missing sensors omitted. */
  sensorTemperaturesCelsius: number[];
  /** Remaining spare capacity, percent. */
  availableSparePercent: number;
  /** Spare level below which the drive raises critical_warning, percent. */
  spareThresholdPercent: number;
  /** Vendor estimate of rated life used, percent (can exceed 100). */
  percentUsed: number;
  /** Lifetime bytes read by the host. */
  bytesRead: number | null;
  /** Lifetime bytes written by the host. */
  bytesWritten: number | null;
  /** Lifetime host read commands. */
  hostReadCommands: number | null;
  /** Lifetime host write commands. */
  hostWriteCommands: number | null;
  /** Minutes the controller has been busy with I/O. */
  controllerBusyMinutes: number | null;
  /** Lifetime power cycles. */
  powerCycles: number | null;
  /** Lifetime powered-on hours. */
  powerOnHours: number | null;
  /** Lifetime power losses without a clean shutdown notification. */
  unsafeShutdowns: number | null;
  /** Lifetime unrecovered data-integrity errors. */
  mediaErrors: number | null;
  /** Lifetime error-information log entries. */
  errorLogEntries: number | null;
  /** Minutes spent above the warning composite temperature. */
  warningTempMinutes: number | null;
  /** Minutes spent above the critical composite temperature. */
  criticalTempMinutes: number | null;
  /** Times the drive entered light thermal throttling (TMT1). */
  thermalThrottleLightCount: number | null;
  /** Seconds spent in light thermal throttling (TMT1). */
  thermalThrottleLightSeconds: number | null;
  /** Times the drive entered heavy thermal throttling (TMT2). */
  thermalThrottleHeavyCount: number | null;
  /** Seconds spent in heavy thermal throttling (TMT2). */
  thermalThrottleHeavySeconds: number | null;
}

/**
 * Parse `nvme smart-log -o json`. The fields the asserts depend on
 * (critical_warning, spare, percent_used) are required and throw when
 * missing; everything else degrades to null.
 */
export function parseSmartLog(json: unknown): SmartCounters {
  if (typeof json !== "object" || json === null) {
    throw new Error("smart-log output is not a JSON object");
  }
  const log = json as Record<string, unknown>;
  const required = (key: string): number => {
    const value = toNumber(log[key]);
    if (value === null) {
      throw new Error(`smart-log output has no numeric "${key}"`);
    }
    return value;
  };
  const optional = (key: string): number | null => toNumber(log[key]);
  const units = (key: string): number | null => {
    const value = optional(key);
    return value === null ? null : value * DATA_UNIT_BYTES;
  };

  const sensors: number[] = [];
  for (let i = 1; i <= 8; i++) {
    const celsius = kelvinToCelsius(optional(`temperature_sensor_${i}`));
    if (celsius !== null) sensors.push(celsius);
  }

  return {
    criticalWarning: required("critical_warning"),
    enduranceGroupCriticalWarning: optional(
      "endurance_grp_critical_warning_summary",
    ),
    temperatureCelsius: kelvinToCelsius(optional("temperature")),
    sensorTemperaturesCelsius: sensors,
    availableSparePercent: required("avail_spare"),
    spareThresholdPercent: required("spare_thresh"),
    percentUsed: required("percent_used"),
    bytesRead: units("data_units_read"),
    bytesWritten: units("data_units_written"),
    hostReadCommands: optional("host_read_commands"),
    hostWriteCommands: optional("host_write_commands"),
    controllerBusyMinutes: optional("controller_busy_time"),
    powerCycles: optional("power_cycles"),
    powerOnHours: optional("power_on_hours"),
    unsafeShutdowns: optional("unsafe_shutdowns"),
    mediaErrors: optional("media_errors"),
    errorLogEntries: optional("num_err_log_entries"),
    warningTempMinutes: optional("warning_temp_time"),
    criticalTempMinutes: optional("critical_comp_time"),
    thermalThrottleLightCount: optional("thm_temp1_trans_count"),
    thermalThrottleLightSeconds: optional("thm_temp1_total_time"),
    thermalThrottleHeavyCount: optional("thm_temp2_trans_count"),
    thermalThrottleHeavySeconds: optional("thm_temp2_total_time"),
  };
}

/** Changes since the previous reading; every field is null on the first. */
export interface SmartDeltas {
  /** Seconds between the previous reading and this one. */
  intervalSeconds: number | null;
  /** New media errors since the previous reading. */
  mediaErrors: number | null;
  /** New error-log entries since the previous reading. */
  errorLogEntries: number | null;
  /** New unsafe shutdowns since the previous reading. */
  unsafeShutdowns: number | null;
  /** New minutes above the warning temperature since the previous reading. */
  warningTempMinutes: number | null;
  /** New minutes above the critical temperature since the previous reading. */
  criticalTempMinutes: number | null;
  /** Bytes written since the previous reading. */
  bytesWritten: number | null;
  /**
   * bytesWritten scaled to a 24-hour rate. Null when the readings are less
   * than {@linkcode MIN_RATE_INTERVAL_SECONDS} apart.
   */
  writeBytesPerDay: number | null;
}

/** The subset of a previous `smart` record that deltas are computed from. */
export interface PreviousSmart {
  /** ISO-8601 capture time of the previous reading. */
  capturedAt?: string;
  /** Lifetime counters from the previous reading. */
  counters?: Partial<SmartCounters>;
}

/**
 * Compute deltas against the previous reading. A counter that went down
 * (a different drive, or a firmware reset) yields null rather than a
 * negative number, so asserts don't misfire.
 */
export function computeDeltas(
  current: SmartCounters,
  capturedAt: string,
  previous: PreviousSmart | null,
): SmartDeltas {
  const prev = previous?.counters;
  const delta = (key: keyof SmartCounters): number | null => {
    const now = current[key];
    const before = prev?.[key];
    if (typeof now !== "number" || typeof before !== "number") return null;
    return now >= before ? now - before : null;
  };
  const intervalSeconds = previous?.capturedAt
    ? (Date.parse(capturedAt) - Date.parse(previous.capturedAt)) / 1000
    : null;
  const validInterval = intervalSeconds !== null && intervalSeconds > 0
    ? intervalSeconds
    : null;
  const bytesWritten = delta("bytesWritten");
  return {
    intervalSeconds: validInterval,
    mediaErrors: delta("mediaErrors"),
    errorLogEntries: delta("errorLogEntries"),
    unsafeShutdowns: delta("unsafeShutdowns"),
    warningTempMinutes: delta("warningTempMinutes"),
    criticalTempMinutes: delta("criticalTempMinutes"),
    bytesWritten,
    writeBytesPerDay: bytesWritten !== null && validInterval !== null &&
        validInterval >= MIN_RATE_INTERVAL_SECONDS
      ? Math.round(bytesWritten / validInterval * 86_400)
      : null,
  };
}

/** One non-empty entry from the controller's error-information log. */
export interface ErrorLogEntry {
  /** Unique, increasing error count for this entry. */
  errorCount: number;
  /** Submission queue the failed command was on. */
  submissionQueueId: number | null;
  /** Command identifier of the failed command. */
  commandId: number | null;
  /** NVMe status field of the completion. */
  statusField: number | null;
  /** First LBA affected, when relevant. */
  lba: number | null;
  /** Namespace the error relates to. */
  namespaceId: number | null;
}

/**
 * Parse `nvme error-log -o json`, keeping only real entries. Unused slots
 * in the log come back zero-filled with error_count 0, so those are dropped.
 */
export function parseErrorLog(json: unknown): ErrorLogEntry[] {
  const errors = (json as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) {
    throw new Error('error-log output has no "errors" array');
  }
  return errors
    .map((raw) => raw as Record<string, unknown>)
    .filter((e) => (toNumber(e.error_count) ?? 0) > 0)
    .map((e) => ({
      errorCount: toNumber(e.error_count) as number,
      submissionQueueId: toNumber(e.sqid),
      commandId: toNumber(e.cmdid),
      statusField: toNumber(e.status_field),
      lba: toNumber(e.lba),
      namespaceId: toNumber(e.nsid),
    }));
}

/** Controller capabilities parsed from `nvme id-ctrl -o json`. */
export interface ControllerCapabilities {
  /** Total NVM capacity in bytes. */
  capacityBytes: number | null;
  /** Warning composite temperature threshold (WCTEMP) in °C. */
  warningTempCelsius: number | null;
  /** Critical composite temperature threshold (CCTEMP) in °C. */
  criticalTempCelsius: number | null;
  /** Whether autonomous power state transitions are supported. */
  apstSupported: boolean | null;
  /** Number of power states the controller supports. */
  powerStates: number | null;
  /** Whether the controller supports device self-test (OACS bit 4). */
  selfTestSupported: boolean | null;
}

/** Parse the capability fields this behavior uses from `nvme id-ctrl -o json`. */
export function parseIdCtrl(json: unknown): ControllerCapabilities {
  const ctrl = (json ?? {}) as Record<string, unknown>;
  const npss = toNumber(ctrl.npss);
  const oacs = toNumber(ctrl.oacs);
  const apsta = toNumber(ctrl.apsta);
  return {
    capacityBytes: toNumber(ctrl.tnvmcap),
    warningTempCelsius: kelvinToCelsius(toNumber(ctrl.wctemp)),
    criticalTempCelsius: kelvinToCelsius(toNumber(ctrl.cctemp)),
    apstSupported: apsta === null ? null : (apsta & 0x01) !== 0,
    // npss is zero-based: npss 4 means power states 0-4.
    powerStates: npss === null ? null : npss + 1,
    selfTestSupported: oacs === null ? null : (oacs & 0x10) !== 0,
  };
}

/** Parse a hwmon `tempN_*` millidegree value to °C; null when unparseable. */
export function parseMillidegrees(text: string): number | null {
  const value = toNumber(text.trim());
  return value === null ? null : value / 1000;
}

const GlobalArgsSchema = z.object({
  device: z.string().default("/dev/nvme0").describe(
    "NVMe controller character device, e.g. /dev/nvme0 (not a namespace " +
      "like /dev/nvme0n1). Validated against /dev/nvmeN before use.",
  ),
  nvmePath: z.string().default("nvme").describe(
    "Path to the nvme-cli binary.",
  ),
  useSudo: z.boolean().default(true).describe(
    "Run nvme through `sudo -n` for the root-only admin commands " +
      "(smart-log, error-log, id-ctrl). Set false when swamp itself runs " +
      "as root. Never prompts: a missing sudoers rule fails fast.",
  ),
  sudoPath: z.string().default("sudo").describe("Path to the sudo binary."),
  sysfsNvmePath: z.string().default("/sys/class/nvme").describe(
    "sysfs directory holding the nvmeN controller entries.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Run an nvme-cli subcommand as JSON, through sudo when configured. */
async function runNvmeJson(
  run: CommandRunner,
  globalArgs: GlobalArgs,
  subcommand: string,
  extraArgs: string[] = [],
): Promise<unknown> {
  validateDevice(globalArgs.device);
  const nvmeArgs = [subcommand, globalArgs.device, ...extraArgs, "-o", "json"];
  const stdout = globalArgs.useSudo
    ? await run(globalArgs.sudoPath, ["-n", globalArgs.nvmePath, ...nvmeArgs])
    : await run(globalArgs.nvmePath, nvmeArgs);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `nvme ${subcommand} ${globalArgs.device} did not return JSON (${error}); is nvme-cli new enough for -o json?`,
    );
  }
}

const CriticalWarningFlagsSchema = z.object({
  spareBelowThreshold: z.boolean(),
  temperatureOutOfRange: z.boolean(),
  reliabilityDegraded: z.boolean(),
  readOnly: z.boolean(),
  volatileBackupFailed: z.boolean(),
  persistentMemoryReadOnly: z.boolean(),
});

const SmartSchema = z.object({
  device: z.string().describe("Controller device the log was read from."),
  criticalWarning: z.number().describe(
    "Raw critical_warning byte. 0 means healthy; see criticalWarningFlags.",
  ),
  criticalWarningFlags: CriticalWarningFlagsSchema.describe(
    "critical_warning decoded into named bits.",
  ),
  enduranceGroupCriticalWarning: z.number().nullable(),
  temperatureCelsius: z.number().nullable().describe(
    "Composite temperature, °C.",
  ),
  sensorTemperaturesCelsius: z.array(z.number()).describe(
    "Per-sensor temperatures, °C, sensor 1 first.",
  ),
  availableSparePercent: z.number(),
  spareThresholdPercent: z.number(),
  percentUsed: z.number().describe(
    "Vendor estimate of rated endurance used, percent. Can exceed 100.",
  ),
  counters: z.record(z.string(), z.number().nullable()).describe(
    "Lifetime counters: bytesRead/Written, host commands, busy minutes, " +
      "power cycles/hours, unsafeShutdowns, mediaErrors, errorLogEntries, " +
      "warning/critical temperature minutes and thermal-throttle counts " +
      "and seconds. Null when the drive doesn't report one.",
  ),
  deltas: z.object({
    intervalSeconds: z.number().nullable(),
    mediaErrors: z.number().nullable(),
    errorLogEntries: z.number().nullable(),
    unsafeShutdowns: z.number().nullable(),
    warningTempMinutes: z.number().nullable(),
    criticalTempMinutes: z.number().nullable(),
    bytesWritten: z.number().nullable(),
    writeBytesPerDay: z.number().nullable(),
  }).describe(
    "Changes since this behavior's previous smart reading. All null on the " +
      "first reading, or when a counter went down (drive swapped/reset).",
  ),
  capturedAt: z.string(),
});

const TemperatureSchema = z.object({
  device: z.string(),
  hwmon: z.string().describe("hwmon directory the readings came from."),
  sensors: z.array(z.object({
    label: z.string().describe('hwmon label, e.g. "Composite", "Sensor 1".'),
    celsius: z.number().nullable(),
    maxCelsius: z.number().nullable().describe(
      "Warning threshold the kernel exposes for this sensor, if any.",
    ),
    critCelsius: z.number().nullable(),
  })),
  compositeCelsius: z.number().nullable().describe(
    "The Composite sensor's reading, hoisted for CEL asserts.",
  ),
  alarm: z.boolean().nullable().describe(
    "Kernel's composite temperature alarm flag (temp1_alarm).",
  ),
  capturedAt: z.string(),
});

const IdentitySchema = z.object({
  device: z.string(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  firmware: z.string().nullable(),
  state: z.string().nullable().describe('Controller state, e.g. "live".'),
  transport: z.string().nullable().describe('e.g. "pcie".'),
  address: z.string().nullable().describe("PCI address, e.g. 0001:01:00.0."),
  capacityBytes: z.number().nullable(),
  warningTempCelsius: z.number().nullable(),
  criticalTempCelsius: z.number().nullable(),
  apstSupported: z.boolean().nullable(),
  powerStates: z.number().nullable(),
  selfTestSupported: z.boolean().nullable(),
  capturedAt: z.string(),
});

const ErrorLogSchema = z.object({
  device: z.string(),
  entries: z.array(z.object({
    errorCount: z.number(),
    submissionQueueId: z.number().nullable(),
    commandId: z.number().nullable(),
    statusField: z.number().nullable(),
    lba: z.number().nullable(),
    namespaceId: z.number().nullable(),
  })).describe("Non-empty error-log entries, newest first."),
  entryCount: z.number(),
  capturedAt: z.string(),
});

/** Method context shape shared by every method in this behavior. */
interface NvmeContext {
  globalArgs: GlobalArgs;
  logger: MinimalLogger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
}

/** Optional injected runner, so tests can stub nvme-cli and sysfs. */
type MethodArgs = { _run?: CommandRunner };

/** Behavior definition for `@aaronge/nvme-health` — NVMe SMART/health telemetry for any Linux host. */
export const behavior = {
  type: "@aaronge/nvme-health",
  version: "2026.11.05.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    smart: {
      description:
        "Health log: critical warnings, spare, wear, lifetime counters, and deltas since the previous reading.",
      schema: SmartSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    temperature: {
      description: "hwmon temperatures (no root needed).",
      schema: TemperatureSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    identity: {
      description:
        "Controller identity from sysfs plus capabilities from id-ctrl.",
      schema: IdentitySchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    errorLog: {
      description: "Non-empty entries from the controller's error log.",
      schema: ErrorLogSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  methods: {
    readSmart: {
      description:
        "Read the health log (`nvme smart-log`, root), decode critical warnings, and record deltas against the previous reading.",
      arguments: z.object({}),
      execute: async (args: MethodArgs, context: NvmeContext) => {
        const run = args._run ?? runCommand;
        const { device } = context.globalArgs;
        const capturedAt = new Date().toISOString();
        context.logger.info("Reading NVMe health log from {device}", {
          device,
        });

        const counters = parseSmartLog(
          await runNvmeJson(run, context.globalArgs, "smart-log"),
        );
        const previous = context.readResource
          ? await context.readResource("smart") as PreviousSmart | null
          : null;
        const deltas = computeDeltas(counters, capturedAt, previous);

        if (counters.criticalWarning !== 0) {
          context.logger.warn(
            "NVMe {device} reports critical_warning={criticalWarning}",
            { device, criticalWarning: counters.criticalWarning },
          );
        }
        context.logger.info(
          "Read NVMe health: {percentUsed}% used, {spare}% spare, {temp}°C",
          {
            percentUsed: counters.percentUsed,
            spare: counters.availableSparePercent,
            temp: counters.temperatureCelsius,
          },
        );

        const {
          criticalWarning,
          enduranceGroupCriticalWarning,
          temperatureCelsius,
          sensorTemperaturesCelsius,
          availableSparePercent,
          spareThresholdPercent,
          percentUsed,
          ...lifetime
        } = counters;
        const handle = await context.writeResource("smart", "smart", {
          device,
          criticalWarning,
          criticalWarningFlags: decodeCriticalWarning(criticalWarning),
          enduranceGroupCriticalWarning,
          temperatureCelsius,
          sensorTemperaturesCelsius,
          availableSparePercent,
          spareThresholdPercent,
          percentUsed,
          counters: lifetime,
          deltas,
          capturedAt,
        });
        return { dataHandles: [handle] };
      },
    },
    readTemperature: {
      description:
        "Read every temperature the drive exposes through hwmon. Needs no privileges.",
      arguments: z.object({}),
      execute: async (args: MethodArgs, context: NvmeContext) => {
        const run = args._run ?? runCommand;
        const { device, sysfsNvmePath } = context.globalArgs;
        const ctrlPath = `${sysfsNvmePath}/${controllerName(device)}`;
        context.logger.info("Reading NVMe hwmon temperatures under {path}", {
          path: ctrlPath,
        });

        const hwmon = (await run("ls", [ctrlPath])).split(/\s+/)
          .find((name) => /^hwmon[0-9]+$/.test(name));
        if (!hwmon) {
          throw new Error(
            `${ctrlPath} has no hwmonN entry; the kernel's nvme hwmon support may be disabled`,
          );
        }
        const hwmonPath = `${ctrlPath}/${hwmon}`;
        const files = (await run("ls", [hwmonPath])).split(/\s+/);
        const indices = [
          ...new Set(
            files.map((f) => f.match(/^temp([0-9]+)_input$/)?.[1])
              .filter((i): i is string => i !== undefined),
          ),
        ].sort((a, b) => Number(a) - Number(b));

        const readOptional = async (name: string) =>
          files.includes(name)
            ? parseMillidegrees(await catFile(run, `${hwmonPath}/${name}`))
            : null;
        const sensors = [];
        for (const i of indices) {
          sensors.push({
            label: files.includes(`temp${i}_label`)
              ? await catFile(run, `${hwmonPath}/temp${i}_label`)
              : `temp${i}`,
            celsius: await readOptional(`temp${i}_input`),
            maxCelsius: await readOptional(`temp${i}_max`),
            critCelsius: await readOptional(`temp${i}_crit`),
          });
        }
        const alarmText = files.includes("temp1_alarm")
          ? await catFile(run, `${hwmonPath}/temp1_alarm`)
          : null;
        context.logger.info("Read {count} NVMe temperature sensors", {
          count: sensors.length,
        });

        const handle = await context.writeResource(
          "temperature",
          "temperature",
          {
            device,
            hwmon: hwmonPath,
            sensors,
            compositeCelsius: sensors.find((s) => s.label === "Composite")
              ?.celsius ?? sensors[0]?.celsius ?? null,
            alarm: alarmText === null ? null : alarmText === "1",
            capturedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    readIdentity: {
      description:
        "Read model, serial, firmware and link details from sysfs, plus capacity, temperature thresholds and power/self-test capabilities from `nvme id-ctrl` (root; those fields are null when it can't run).",
      arguments: z.object({}),
      execute: async (args: MethodArgs, context: NvmeContext) => {
        const run = args._run ?? runCommand;
        const { device, sysfsNvmePath } = context.globalArgs;
        const ctrlPath = `${sysfsNvmePath}/${controllerName(device)}`;
        context.logger.info("Reading NVMe identity for {device}", { device });

        const sysfs = async (name: string): Promise<string | null> => {
          try {
            return await catFile(run, `${ctrlPath}/${name}`) || null;
          } catch {
            return null;
          }
        };

        let capabilities = parseIdCtrl(null);
        try {
          capabilities = parseIdCtrl(
            await runNvmeJson(run, context.globalArgs, "id-ctrl"),
          );
        } catch (error) {
          context.logger.warn(
            "nvme id-ctrl failed, leaving capability fields null: {error}",
            { error: String(error) },
          );
        }

        const identity = {
          device,
          model: await sysfs("model"),
          serial: await sysfs("serial"),
          firmware: await sysfs("firmware_rev"),
          state: await sysfs("state"),
          transport: await sysfs("transport"),
          address: await sysfs("address"),
          ...capabilities,
          capturedAt: new Date().toISOString(),
        };
        context.logger.info("NVMe {device} is {model}, firmware {firmware}", {
          device,
          model: identity.model,
          firmware: identity.firmware,
        });
        const handle = await context.writeResource(
          "identity",
          "identity",
          identity,
        );
        return { dataHandles: [handle] };
      },
    },
    readErrorLog: {
      description:
        "Read the controller's error-information log (`nvme error-log`, root) and keep the non-empty entries.",
      arguments: z.object({}),
      execute: async (args: MethodArgs, context: NvmeContext) => {
        const run = args._run ?? runCommand;
        context.logger.info("Reading NVMe error log from {device}", {
          device: context.globalArgs.device,
        });
        const entries = parseErrorLog(
          await runNvmeJson(run, context.globalArgs, "error-log"),
        );
        if (entries.length > 0) {
          context.logger.warn(
            "NVMe error log has {count} entries",
            { count: entries.length },
          );
        } else {
          context.logger.info("NVMe error log is empty");
        }
        const handle = await context.writeResource("errorLog", "errorLog", {
          device: context.globalArgs.device,
          entries,
          entryCount: entries.length,
          capturedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
