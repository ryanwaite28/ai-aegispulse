#!/usr/bin/env bash
# Prepares the storage node's data SSD for k3s local-path volumes (ADR-0015, PROJECT.md §9.3 step 3).
# Run ON the storage node as root:  sudo bash 10-storage-node-disk.sh /dev/disk/by-id/<whole-disk-id>
#
# Result (idempotent; re-running on a prepared node changes nothing):
#   - an ext4 filesystem labelled k3s-data, mounted at /mnt/data by UUID (nofail). An existing ext4 on the
#     whole disk or on partition 1 is adopted as-is and only relabelled (non-destructive); otherwise the disk
#     gets one GPT partition
#   - /mnt/data/k3s-storage bind-mounted at /var/lib/rancher/k3s/storage, the default local-path
#     directory, so every local-path PV on this node lands on the SSD with no provisioner config change
#   - k3s-agent requires both mounts: if the SSD is missing the node goes NotReady instead of silently
#     writing database files to the OS disk
# The only destructive step (wiping the disk) asks for a typed confirmation and never runs unattended.
set -euo pipefail

LABEL="k3s-data"
DATA_MNT="/mnt/data"
K3S_STORAGE="/var/lib/rancher/k3s/storage"
BIND_SRC="${DATA_MNT}/k3s-storage"
DROPIN_DIR="/etc/systemd/system/k3s-agent.service.d"
DROPIN="${DROPIN_DIR}/10-require-data-mount.conf"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }

[[ $(id -u) -eq 0 ]] || die "run as root (sudo)"
DISK="${1:-}"
[[ -n "$DISK" ]] || die "usage: $0 /dev/disk/by-id/<whole-disk-id>"
[[ "$DISK" == /dev/disk/by-id/* ]] || die "pass a stable /dev/disk/by-id/ path, not /dev/sdX (device letters can change between boots)"
[[ "$DISK" != *-part* ]] || die "pass the whole disk, not a partition"
[[ -b "$DISK" ]] || die "$DISK is not a block device"
PART="${DISK}-part1"
DEV="$(readlink -f "$DISK")"

root_chain="$(lsblk -nso NAME "$(readlink -f "$(findmnt -no SOURCE /)")" 2>/dev/null | tr -cd 'a-z0-9\n-' || true)"
if grep -qx "$(basename "$DEV")" <<<"$root_chain"; then
  die "$DISK backs the root filesystem"
fi

# 1. Filesystem: adopt an existing ext4 (whole disk, or our labelled partition 1); format only otherwise.
FS_DEV=""
if [[ "$(blkid -s TYPE -o value "$DISK" 2>/dev/null || true)" == "ext4" ]]; then
  FS_DEV="$DISK"
  log "adopting existing whole-disk ext4 on ${DISK}; not formatting"
elif [[ -b "$PART" ]] && [[ "$(blkid -s LABEL -o value "$PART" 2>/dev/null || true)" == "$LABEL" ]]; then
  FS_DEV="$PART"
  log "filesystem ${LABEL} already present on ${PART}; not formatting"
else
  mounted="$(lsblk -nro MOUNTPOINTS "$DEV")"
  if [[ -n "${mounted//[[:space:]]/}" ]]; then
    die "$DEV (or a partition on it) is mounted; unmount it first"
  fi
  echo "About to ERASE every partition and filesystem on:"
  lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MODEL,SERIAL "$DEV"
  if [[ -b "$PART" ]] && blkid "$PART" >/dev/null 2>&1; then
    peek="$(mktemp -d)"
    if mount -o ro "$PART" "$peek" 2>/dev/null; then
      echo "--- existing contents of ${PART} (read-only peek) ---"
      df -h "$peek" | tail -1
      find "$peek" -mindepth 1 -maxdepth 1 -printf "%M %10s %p\n" 2>/dev/null | head -20 || true
      umount "$peek"
    fi
    rmdir "$peek"
  fi
  confirm="WIPE $(basename "$DEV")"
  read -r -p "Type '${confirm}' to continue: " answer
  [[ "$answer" == "$confirm" ]] || die "confirmation did not match; nothing changed"
  log "wiping signatures"
  wipefs --all "$DEV"
  log "creating GPT with one Linux partition"
  printf 'label: gpt\n,,L\n' | sfdisk --quiet "$DEV"
  udevadm settle
  [[ -b "$PART" ]] || die "partition ${PART} did not appear"
  log "creating ext4 (${LABEL}, 1% reserved blocks)"
  mkfs.ext4 -q -F -L "$LABEL" -m 1 "$PART"
  FS_DEV="$PART"
fi
if [[ "$(blkid -s LABEL -o value "$FS_DEV" 2>/dev/null || true)" != "$LABEL" ]]; then
  e2label "$FS_DEV" "$LABEL"
  log "labelled ${FS_DEV} as ${LABEL}"
fi
UUID="$(blkid -s UUID -o value "$FS_DEV")"
[[ -n "$UUID" ]] || die "could not read filesystem UUID"

# 2. Mounts (fstab is the source of truth; entries keyed by UUID and mount point).
add_fstab() {
  grep -qE "^[^#]*[[:space:]]$2[[:space:]]" /etc/fstab && return 0
  [[ -z "$(tail -c1 /etc/fstab)" ]] || echo >>/etc/fstab # never glue onto a last line lacking a newline
  echo "$1" >>/etc/fstab
  findmnt --verify --tab-file /etc/fstab >/dev/null 2>&1 || die "/etc/fstab failed verification after adding $2; inspect it before rebooting"
  log "fstab: added $2"
}
mkdir -p "$DATA_MNT"
add_fstab "UUID=${UUID} ${DATA_MNT} ext4 defaults,noatime,nofail,x-systemd.device-timeout=30s 0 2" "$DATA_MNT"
systemctl daemon-reload
findmnt -n "$DATA_MNT" >/dev/null || mount "$DATA_MNT"
[[ "$(findmnt -no UUID "$DATA_MNT")" == "$UUID" ]] || die "${DATA_MNT} is not backed by ${LABEL} (UUID ${UUID})"
install -d -m 0711 -o root -g root "$BIND_SRC"

if ! findmnt -n "$K3S_STORAGE" >/dev/null; then
  if [[ -d "$K3S_STORAGE" ]] && [[ -n "$(ls -A "$K3S_STORAGE")" ]]; then
    die "${K3S_STORAGE} already holds volumes on the OS disk; migrate them (backup, delete PVC, restore) before binding"
  fi
  mkdir -p "$K3S_STORAGE"
fi
add_fstab "${BIND_SRC} ${K3S_STORAGE} none bind,nofail,x-systemd.requires-mounts-for=${DATA_MNT} 0 0" "$K3S_STORAGE"
systemctl daemon-reload
findmnt -n "$K3S_STORAGE" >/dev/null || mount "$K3S_STORAGE"

# 3. k3s-agent must not start without the data disk (applies from its next start; no restart needed now).
mkdir -p "$DROPIN_DIR"
want="[Unit]
RequiresMountsFor=${DATA_MNT} ${K3S_STORAGE}"
if [[ ! -f "$DROPIN" ]] || [[ "$(cat "$DROPIN")" != "$want" ]]; then
  printf '%s\n' "$want" >"$DROPIN"
  systemctl daemon-reload
  log "k3s-agent now requires ${DATA_MNT} and ${K3S_STORAGE}"
fi

log "verification"
findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS "$DATA_MNT"
findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS "$K3S_STORAGE"
df -h "$DATA_MNT" | tail -1
systemctl show k3s-agent -p RequiresMountsFor
log "done"
