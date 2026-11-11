// lib/proximity-notification.ts
// Sound and browser notification when a CHATCO jeep approaches within 1km

/** Track which vehicles we've already notified about (avoid spam) */
const notifiedVehicles = new Set<string>();

/**
 * Play a proximity alert sound using Web Audio API.
 * Generates a short two-tone beep programmatically — no external audio file needed.
 */
export function playProximitySound(): void {
  if (typeof window === "undefined") return;

  try {
    const ctx = new AudioContext();

    // First beep (higher pitch)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.value = 880; // A5
    gain1.gain.value = 0.3;
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.15);

    // Second beep (lower pitch)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.value = 660; // E5
    gain2.gain.value = 0.3;
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(ctx.currentTime + 0.2);
    osc2.stop(ctx.currentTime + 0.35);
  } catch {
    // Web Audio API not available — silent fallback
  }
}

/**
 * Play a different sound for hail acceptance.
 * A pleasant three-tone chime.
 */
export function playHailAcceptedSound(): void {
  if (typeof window === "undefined") return;

  try {
    const ctx = new AudioContext();
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0.25;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.2);
    });
  } catch {
    // Silent fallback
  }
}

/**
 * Conductor alert for a new hail: a two-note notification chime plus a
 * vibration. A web page can't read the phone's silent/ringer mode, so both
 * always fire — on silent the vibration still gets through.
 */
export function alertNewHail(): void {
  if (typeof window === "undefined") return;

  if (typeof navigator.vibrate === "function") navigator.vibrate([300, 150, 300]);

  try {
    const ctx = new AudioContext();
    [987.77, 1318.51].forEach((freq, i) => { // B5 then E6
      const start = ctx.currentTime + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // Quick fade-out so it reads as a chime, not a flat beep.
      gain.gain.setValueAtTime(0.35, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
    // Browsers cap open AudioContexts; release this one once the chime ends.
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    // Web Audio unavailable — the vibration above is the fallback.
  }
}

/**
 * Request browser notification permission.
 * Returns true if permission was granted.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }

  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;

  const result = await Notification.requestPermission();
  return result === "granted";
}

/**
 * Check if browser notification permission is already granted.
 */
export function hasNotificationPermission(): boolean {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }
  return Notification.permission === "granted";
}

/**
 * Send a browser notification when a nearby CHATCO jeep is detected.
 * Only notifies once per vehicle until reset.
 */
export function sendProximityNotification(
  vehiclePlate: string,
  distance: string
): void {
  if (!hasNotificationPermission()) return;

  // Don't spam — only notify once per vehicle
  if (notifiedVehicles.has(vehiclePlate)) return;
  notifiedVehicles.add(vehiclePlate);

  try {
    const notification = new Notification("CHATCO Jeep Nearby! 🚐", {
      body: `${vehiclePlate} is ${distance} away. Get ready to board!`,
      icon: "/logo-transparent.png",
      tag: `chatco-nearby-${vehiclePlate}`,
      requireInteraction: false,
      silent: false,
    });

    // Auto-close after 5 seconds
    setTimeout(() => notification.close(), 5000);
  } catch {
    // Notification API not available
  }

  // Also play sound
  playProximitySound();
}

/**
 * Clear the notified vehicles set.
 * Call this when the commuter changes location significantly
 * or starts a new tracking session.
 */
export function clearNotifiedVehicles(): void {
  notifiedVehicles.clear();
}

/**
 * Check if we've already notified about a specific vehicle.
 */
export function hasNotifiedVehicle(vehiclePlate: string): boolean {
  return notifiedVehicles.has(vehiclePlate);
}