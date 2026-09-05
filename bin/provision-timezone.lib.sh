# Sourced by bin/provision.sh. Kept separate so effective-zone discovery,
# mutation, and readback can be tested without changing the machine timezone.

provision_host_timezone() {
  local effective readback

  if ! effective="$($SUDO timedatectl show --property=Timezone --value 2>/dev/null)"; then
    blocked "could not read the host time zone for HOST_TIMEZONE=$HOST_TIMEZONE"
    return 0
  fi
  if [[ "$effective" == "$HOST_TIMEZONE" ]]; then
    ok "host time zone: $HOST_TIMEZONE"
    return 0
  fi

  if ! $SUDO timedatectl set-timezone "$HOST_TIMEZONE"; then
    blocked "could not set the host time zone to HOST_TIMEZONE=$HOST_TIMEZONE"
    return 0
  fi
  if ! readback="$($SUDO timedatectl show --property=Timezone --value 2>/dev/null)"; then
    blocked "set the host time zone to $HOST_TIMEZONE but could not verify its readback"
    return 0
  fi
  if [[ "$readback" != "$HOST_TIMEZONE" ]]; then
    blocked "host time zone readback is '$readback', expected HOST_TIMEZONE=$HOST_TIMEZONE"
    return 0
  fi

  changed "set host time zone to $HOST_TIMEZONE"
}
