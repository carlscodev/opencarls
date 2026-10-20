#!/usr/bin/env bash
# ============================================================================
# OpenCarls — FASE 1: Entorno Ubuntu Desktop (GNOME / X11) SIN RESTRICCIONES
# ----------------------------------------------------------------------------
# Instala: Bun 1.2+, xdotool, wmctrl, scrot, ripgrep, xclip, imagemagick,
# fuentes para overlays, sudo sin contraseña y política de escritorio sin
# bloqueos para el daemon agéntico perpetuo.
#
# Uso:  bash setup_ubuntu.sh            (idempotente, seguro de re-ejecutar)
#       bash setup_ubuntu.sh --no-gui   (omite gsettings/xhost de GNOME)
# ============================================================================
set -euo pipefail

NO_GUI=0
[[ "${1:-}" == "--no-gui" ]] && NO_GUI=1

if [[ $EUID -eq 0 ]]; then
  SUDO_USER_RESOLVED="${SUDO_USER:-root}"
  SUDO=""
else
  SUDO_USER_RESOLVED="$(id -un)"
  SUDO="sudo"
fi

log()  { printf '\033[1;36m[opencarls]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[opencarls][warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[opencarls][fatal]\033[0m %s\n' "$*" >&2; exit 1; }

log "Usuario objetivo: ${SUDO_USER_RESOLVED}  (EUID=${EUID})"

# ---------------------------------------------------------------- apt pools --
APT_PACKAGES=(
  # Visión & control X11/GNOME
  xdotool wmctrl scrot x11-utils x11-xserver-utils xclip imagemagick
  # Captura alternativa (fallbacks de gnome_vision)
  gnome-screenshot
  # Búsqueda de código de alto rendimiento
  ripgrep
  # Utilidades de automatización / daemon
  jq curl wget git unzip ca-certificates procps psmisc lsof
  # Fuentes TrueType para los overlays SVG de sharp
  fonts-dejavu-core fonts-liberation
  # Puente PTY / soporte de compilación para módulos nativos opcionales
  python3 make g++
)

log "Actualizando índices de apt…"
$SUDO apt-get update -y

log "Instalando paquetes del sistema (${#APT_PACKAGES[@]})…"
DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"

# -------------------------------------------------------------------- Bun ----
if ! command -v bun >/dev/null 2>&1; then
  log "Instalando Bun (bun.sh/install)…"
  curl -fsSL https://bun.sh/install | bash
fi

BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
if ! command -v bun >/dev/null 2>&1 && [[ -x "${BUN_BIN}/bun" ]]; then
  export PATH="${BUN_BIN}:${PATH}"
fi
command -v bun >/dev/null 2>&1 || die "Bun no quedó instalado/in PATH"

# PATH persistente en bashrc (daemon + sesiones bash persistentes)
BASHRC="${HOME}/.bashrc"
if ! grep -q '# opencarls:begin' "$BASHRC" 2>/dev/null; then
  cat >> "$BASHRC" <<'EOF'

# opencarls:begin
export PATH="$HOME/.bun/bin:$PATH"
# opencarls:end
EOF
  log "PATH de Bun añadido a ~/.bashrc"
fi

# ------------------------------------------------- sudo sin contraseña (YOLO)
# Entorno aislado dedicado: el agente ejecuta sudo directo, sin prompt.
if [[ $EUID -ne 0 ]]; then
  log "Habilitando sudo sin contraseña para '${SUDO_USER_RESOLVED}'…"
  echo "${SUDO_USER_RESOLVED} ALL=(ALL) NOPASSWD:ALL" | $SUDO tee /etc/sudoers.d/90-opencarls >/dev/null
  $SUDO chmod 0440 /etc/sudoers.d/90-opencarls
  $SUDO visudo -cf /etc/sudoers.d/90-opencarls >/dev/null || die "sudoers inválido"
fi

# --------------------------------------------------- entorno X11 global ------
log "Configurando entorno X11 global (/etc/profile.d/10-opencarls-x11.sh)…"
cat <<'EOF' | $SUDO tee /etc/profile.d/10-opencarls-x11.sh >/dev/null
# OpenCarls: sesión gráfica disponible para cualquier proceso heredado.
export DISPLAY="${DISPLAY:-:0}"
if [[ -z "${XAUTHORITY:-}" ]]; then
  for _xa in "$HOME/.Xauthority" "/var/run/lightdm/root/:0" "$HOME/.xauth/*"; do
    [[ -e "$_xa" ]] && export XAUTHORITY="$_xa" && break
  done
  unset _xa
fi
EOF
$SUDO chmod 0644 /etc/profile.d/10-opencarls-x11.sh

# ------------------------------------------- política de escritorio (GNOME) ---
if [[ $NO_GUI -eq 0 ]] && command -v gsettings >/dev/null 2>&1; then
  log "Aplicando política GNOME: sin bloqueo ni suspensión (corre como ${SUDO_USER_RESOLVED})…"
  sudo -u "$SUDO_USER_RESOLVED" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SUDO_USER_RESOLVED")/bus" bash -c '
    gsettings set org.gnome.desktop.session idle-delay 0 || true
    gsettings set org.gnome.desktop.screensaver lock-enabled false || true
    gsettings set org.gnome.desktop.screensaver idle-activation-enabled false || true
    gsettings set org.gnome.settings-daemon.plugins.power idle-dim false || true
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type "nothing" || true
    gsettings set org.gnome.desktop.input-sources xkb-options "[]" || true
  ' || warn "No se pudieron aplicar gsettings (¿sesión GNOME activa?)"
fi

# ------------------------------ acceso X11 sin restricciones (host dedicado) --
if [[ $NO_GUI -eq 0 ]] && command -v xhost >/dev/null 2>&1; then
  log "Autorizando acceso X11 local (root + usuario)…"
  for d in ":0" ":1"; do
    DISPLAY="$d" xhost +SI:localuser:root >/dev/null 2>&1 || true
    DISPLAY="$d" xhost +SI:localuser:"${SUDO_USER_RESOLVED}" >/dev/null 2>&1 || true
    DISPLAY="$d" xhost +local: >/dev/null 2>&1 || true
  done
fi

# ------------------------------------------------------- directorios agent ----
AGENT_HOME="${OPENCARLS_HOME:-${HOME}/.agent}"
log "Creando árbol de datos del agente en ${AGENT_HOME}…"
mkdir -p "${AGENT_HOME}"/{captures,logs,skills,sessions,tmp}

# ------------------------------------------------------------------ resumen ---
log "────────────── Verificación final ──────────────"
printf '  bun        : %s\n' "$(bun --version)"
printf '  xdotool    : %s\n' "$(command -v xdotool || echo AUSENTE)"
printf '  wmctrl     : %s\n' "$(command -v wmctrl  || echo AUSENTE)"
printf '  scrot      : %s\n' "$(command -v scrot    || echo AUSENTE)"
printf '  rg         : %s\n' "$(command -v rg       || echo AUSENTE)"
printf '  xclip      : %s\n' "$(command -v xclip    || echo AUSENTE)"
printf '  sudo NOPW  : %s\n' "$(sudo -n true 2>/dev/null && echo OK || echo REVISAR)"
printf '  DISPLAY    : %s\n' "${DISPLAY:-:0 (se resuelve en sesión gráfica)}"
printf '  agent home : %s\n' "${AGENT_HOME}"
log "FASE 1 — entorno listo. Arranca el daemon con:  bun run src/index.ts tools"
