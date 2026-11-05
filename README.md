# @aaronge/nvme-health

NVMe drive health for any Linux host, as a typed, versioned
[Swamp](https://github.com/swamp-club/swamp) behavior. It reads the drive's
SMART/health log (critical warnings, spare capacity, wear, media errors,
unsafe shutdowns, thermal throttling), hwmon temperatures, controller
identity and the error log. Each health reading records how its counters
changed since the previous one, so workflows can alert on *new* media
errors or unsafe shutdowns instead of on a lifetime counter forever.

Built on a Raspberry Pi 5 booting from NVMe, but nothing in it is
Pi-specific: it works on any Linux host with nvme-cli.

## Installation

```bash
swamp extension pull @aaronge/nvme-health
swamp behavior create @aaronge/nvme-health nvme-local
```

Requires [nvme-cli](https://github.com/linux-nvme/nvme-cli)
(`apt install nvme-cli`).

### Privileges

The health log, error log and `id-ctrl` are NVMe admin commands, and the
kernel only allows those for root (CAP_SYS_ADMIN), whatever the device
node's permissions. By default the behavior runs them as
`sudo -n nvme ...`. `-n` never prompts, so a missing rule fails fast instead
of hanging a scheduled run. A narrow sudoers rule is enough:

```
# /etc/sudoers.d/nvme-health (edit with: sudo visudo -f /etc/sudoers.d/nvme-health)
youruser ALL=(root) NOPASSWD: /usr/sbin/nvme smart-log /dev/nvme[0-9]* -o json, /usr/sbin/nvme error-log /dev/nvme[0-9]* -o json, /usr/sbin/nvme id-ctrl /dev/nvme[0-9]* -o json
```

If swamp already runs as root, set `useSudo: false`. `readTemperature`
needs no privileges at all, and `readIdentity` still fills in its sysfs
fields when `id-ctrl` can't run.

## Usage

```bash
swamp behavior run nvme-local readSmart
swamp behavior run nvme-local readTemperature
swamp behavior run nvme-local readIdentity
swamp behavior run nvme-local readErrorLog

swamp data query 'modelName == "nvme-local" && name == "smart"' --json
```

From CEL, for example in another workflow's assert:

```yaml
expr: >-
  data.latest("nvme-local", "smart").attributes.deltas.unsafeShutdowns == 0
```

## Global arguments

| Arg | Default | Notes |
| --- | --- | --- |
| `device` | `"/dev/nvme0"` | Controller character device, not a namespace (`/dev/nvme0n1`). Must match `/dev/nvmeN`; anything else is rejected before a command runs. |
| `nvmePath` | `"nvme"` | Path to nvme-cli. |
| `useSudo` | `true` | Run the root-only commands through `sudo -n`. Set `false` when swamp runs as root. |
| `sudoPath` | `"sudo"` | Path to sudo. |
| `sysfsNvmePath` | `"/sys/class/nvme"` | Where the `nvmeN` controller entries live. |

## How it works

Commands run as subprocesses with argument arrays, never through a shell,
and the device is validated first.

- **`smart`** (`readSmart`, root): `nvme smart-log <device> -o json`.
  Temperatures are converted from the spec's Kelvin to °C, and data units
  (thousands of 512-byte blocks) to bytes. `criticalWarning` is kept raw
  and also decoded into `criticalWarningFlags`: spare below threshold,
  temperature out of range, reliability degraded, read-only, volatile
  backup failed, persistent memory read-only. Lifetime counters live under
  `counters`. A counter the drive doesn't report is `null`, never a guessed
  0.

  `deltas` compares the reading with this behavior's previous `smart` data
  (via `readResource`). It reports new media errors, error-log entries,
  unsafe shutdowns and over-temperature minutes, plus bytes written and a
  projected `writeBytesPerDay`. That projection needs readings at least 5
  minutes apart, because writes are bursty. Every delta is `null` on the
  first reading, and also when a counter goes *down* (a swapped drive or a
  firmware reset), so asserts don't misfire on a negative number.
- **`temperature`** (`readTemperature`, no root): every `tempN` sensor the
  drive exposes under its hwmon directory, with labels ("Composite",
  "Sensor 1", …) and the kernel's max/crit thresholds. `compositeCelsius`
  and `alarm` are hoisted for asserts.
- **`identity`** (`readIdentity`): model, serial, firmware, state,
  transport and PCI address from sysfs, plus capacity, the drive's own
  warning/critical temperature thresholds, APST support, the number of
  power states and self-test support from `nvme id-ctrl` (root). The
  `id-ctrl` fields are `null` when it can't run.
- **`errorLog`** (`readErrorLog`, root): `nvme error-log`. Unused slots
  come back zero-filled and are dropped, so `entries` holds only real
  errors.

Reading the health log is an admin command the controller answers from
its own state. It doesn't touch flash, so it adds no wear, and takes about
15 ms. sysfs reads go through `cat` rather than Deno's file API, because
every `/sys/class/nvme/*` entry is a symlink into `/sys/devices` and Deno's
sandbox otherwise demands `--allow-all` (same as `@aaronge/host-health`).

## Workflow

The package ships two workflows, listed under `workflows:` in
`manifest.yaml`, so `swamp extension pull` installs them with the behavior.
Both expect a behavior instance named `nvme-local`, and run on their
`trigger.schedule` under `swamp serve`. Override a schedule or input
without editing the package with
`swamp workflow trigger set <name> --schedule "..." --input key=value`.

- **`@aaronge/nvme-health`**, every 15 minutes (`*/15 * * * *`). Runs
  `readSmart` and `readTemperature`, then asserts:
  - no critical warning (including the endurance-group summary);
  - spare above the drive's threshold plus `spareMarginPercent` (default
    5);
  - `percentUsed` below `maxPercentUsed` (default 80);
  - composite temperature below `tempWarnCelsius` (default 70), with no
    new minutes above the drive's own warning threshold;
  - no new media errors or error-log entries;
  - write rate below `maxWriteGBPerDay` (default 0, meaning off).

  New unsafe shutdowns are reported with `allowFailure: true`. They witness
  power loss, not a drive fault, so pair them with a power check if you
  want an alert. A `report` job prints a summary whatever the asserts
  decide.
- **`@aaronge/nvme-inventory`**, daily at 06:30 (`30 6 * * *`). Runs
  `readIdentity` and `readErrorLog` and asserts the controller is `live`
  and the error log is empty.

15 minutes suits counters that move this slowly. The Debian
`prometheus-node-exporter-collectors` NVMe collector uses the same
cadence.

## License

MIT — see [LICENSE](LICENSE).
