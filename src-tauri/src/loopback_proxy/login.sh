#!/bin/sh
# Owned by Meta API. Never modify system proxy rules or log environment values.
set -eu
umask 077
root=$1
mkdir "$root/lock" 2>/dev/null || exit 1
trap 'rmdir "$root/lock"' 0
trap 'exit 1' 1 2 15
upper=$(/bin/launchctl getenv NO_PROXY)
lower=$(/bin/launchctl getenv no_proxy)
restore() {
    if [ -n "$2" ]; then /bin/launchctl setenv "$1" "$2"; else /bin/launchctl unsetenv "$1"; fi
}
if [ "${2:-apply}" = restore ]; then
    applied=$(cat "$root/applied")
    before_upper=$(cat "$root/before-upper")
    before_lower=$(cat "$root/before-lower")
    # All comparisons precede writes. A previous complete restoration is retryable.
    if [ "$upper" = "$before_upper" ] && [ "$lower" = "$before_lower" ]; then exit 0; fi
    [ "$upper" = "$applied" ] && [ "$lower" = "$applied" ] || exit 2
    restore NO_PROXY "$before_upper"
    if ! restore no_proxy "$before_lower"; then
        restore NO_PROXY "$upper"
        exit 1
    fi
    exit 0
fi
# Idempotent in the same session: retain the pre-repair snapshot.
if [ -f "$root/applied" ] && [ "$upper" = "$(cat "$root/applied")" ] && [ "$lower" = "$upper" ]; then
    exit 0
fi
printf %s "$upper" > "$root/before-upper"
printf %s "$lower" > "$root/before-lower"
# Empty launchd values are restored as unset; both mean no exclusions.
value="$upper,$lower,$(cat "$root/baseline"),localhost,127.0.0.1,::1"
/bin/launchctl setenv NO_PROXY "$value"
if ! /bin/launchctl setenv no_proxy "$value"; then
    if [ -n "$upper" ]; then /bin/launchctl setenv NO_PROXY "$upper"; else /bin/launchctl unsetenv NO_PROXY; fi
    exit 1
fi
printf %s "$value" > "$root/applied"
