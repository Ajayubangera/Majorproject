export type ViolenceLevel = "high" | "medium" | "low";
export type ViolenceFilterType = "all" | ViolenceLevel;

export interface ViolenceConfig {
  level: ViolenceLevel;
  label: string;
  shortLabel: string;
  color: string;
  border: string;
  bg: string;
  badgeBg: string;
  glow: string;
  dotColor: string;
}

/**
 * Determines the threat / violence level of an alert:
 * 
 * 1. 'low' (Normal / Green):
 *    - Explicitly normal operational state, normal indoor/outdoor setting, routine movement.
 *    - Gemini descriptions with "no indication of", "no threat", "no weapon", "no violence", "false positive".
 * 
 * 2. 'high' (High Threat / Red):
 *    - Lethal weapons (knife, blade, dagger, gun, firearm, weapon, cutting tool).
 *    - Active physical violence (fighting, combat, assault, physical violence, brawl).
 *    - Extreme hazards (fire, thermal hazard, explosion, arson).
 *    - ONLY when not negated by negative phrases.
 * 
 * 3. 'medium' (Medium Threat / Orange):
 *    - Suspicious & policy-violating behaviors without weapons:
 *    - Loitering, running, trespassing, unauthorized perimeter intrusion, climbing, prohibited phone use.
 */
export function getViolenceLevel(alert: any): ViolenceLevel {
  if (!alert) return "low";

  const anomaly = (alert.anomaly_type || "").toLowerCase().trim();
  const desc = (alert.threat_description || "").toLowerCase().trim();

  // ─── Step 1: Explicit Normal / Safe Environment & Negation Checks (Top Priority) ───
  // Gemini descriptions frequently say:
  // - "There are no indicators of violence, unauthorized intrusion, weapons, fire/smoke, or suspicious loitering."
  // - "There are no visible signs of violence, weapons, fire/smoke..."
  // - "...which does not constitute a threat."
  // These must be recognized as SAFE / NORMAL (low), NOT as affirmative weapons!

  // Direct sentence negations ("there is no running, violence, weapon...", "there are no...", "no suspicious activity")
  const directNoPattern = /\b(there\s+is\s+no|there\s+are\s+no|no\s+(evidence|sign|signs|indication|indications|indicator|indicators|trace|traces|threat|active\s+threat|suspicious|violence|weapon|weapons|fighting|fire|smoke|running|loitering))\b/i;
  const negationRegex = /\b(no|without|neither|not any|free of|devoid of)\s+([a-z\s,]+)?(indicator|indicators|indication|indications|sign|signs|evidence|threat|trace|traces|weapon|weapons|violence|running|fire|hazard)\b/i;
  const threatNegationRegex = /\b(not|does not|do not|doesn't|don't)\s+(constitute|indicate|suggest|appear\s+to\s+be|seem\s+to\s+be|represent|show)\s+(a\s+|an\s+|any\s+)?(threat|danger|hazard|anomaly|concern|violence|weapon)\b/i;
  const explicitSafeRegex = /\b(normal|routine|safe|casual|harmless|peaceful|clear)\s+(room|indoor|outdoor|setting|environment|state|activity|scene|operation|monitoring)\b/i;
  const safeEnvRoutinePattern = /\b(residential|office|indoor|room|home|workspace|setting|environment)\b/i.test(desc) &&
    /\b(sitting|stationary|drinking|holding\s+a\s+glass|casual|casually|routine|harmless|peaceful|normal\s+operational)\b/i.test(desc) &&
    !desc.includes("holding a knife") && !desc.includes("holding a gun");

  const normalIndicatorPhrases = [
    "normal operational", "normal operational state", "normal activity",
    "normal room", "normal monitoring", "normal environment", "normal setting", "normal state",
    "residential or office", "office setting", "residential setting",
    "offline analysis", "not gemini verified", "offline simulation",
    "no indicator", "no indicators", "no indication", "no indications",
    "no visible sign", "no visible signs", "no sign", "no signs",
    "no evidence", "no threat", "no active threat", "no malicious",
    "no running", "no violence", "no weapon", "no weapons", "no fire", "no smoke", "no suspicious",
    "not a threat", "not constitute a threat", "does not constitute a threat",
    "casually looking", "looking around", "looking upwards", "holding a glass",
    "false positive", "harmless", "routine activity", "simply posing"
  ];

  const isSafeContext = 
    desc.includes("normal operational") ||
    desc.includes("offline analysis") ||
    desc.includes("normal state") ||
    safeEnvRoutinePattern ||
    directNoPattern.test(desc) ||
    negationRegex.test(desc) || 
    threatNegationRegex.test(desc) || 
    explicitSafeRegex.test(desc) ||
    normalIndicatorPhrases.some(p => desc.includes(p)) ||
    ["normal", "safe", "none"].includes(anomaly);

  // If the context is explicitly safe or negated, ONLY an explicit affirmative weapon in hand can override to high
  if (isSafeContext) {
    const affirmativeHighActions = [
      "holding a knife", "carrying a knife", "brandishing a knife", "armed with a knife", "knife in hand",
      "holding a gun", "carrying a gun", "brandishing a gun", "armed with a gun", "gun in hand",
      "holding a weapon", "carrying a weapon", "active physical fight", "active combat", "active shooting"
    ];
    if (affirmativeHighActions.some(action => desc.includes(action))) {
      return "high";
    }
    // Safe / routine environment -> Low (Normal / Safe)
    return "low";
  }

  // ─── Step 2: High Threat Category (Weapons & Physical Violence ONLY) ───
  const highKeywords = [
    "knife", "blade", "dagger", "machete", "gun", "firearm", "pistol", "rifle",
    "weapon", "fighting", "physical fight", "combat", "active combat", "assault",
    "physical violence", "active violence", "punching", "kicking", "brawl",
    "fire", "thermal hazard", "arson", "explosion"
  ];
  if (highKeywords.some(k => anomaly.includes(k) || desc.includes(k))) {
    return "high";
  }

  // ─── Step 3: Medium Threat Category (Loitering, Running, Intrusion, Phone) ───
  const mediumKeywords = [
    "loitering", "loiter", "running", "run", "sprint", "fleeing",
    "trespassing", "intrusion", "unauthorized", "phone_use", "phone", "mobile phone",
    "climbing", "pacing"
  ];
  if (mediumKeywords.some(k => anomaly.includes(k) || desc.includes(k))) {
    return "medium";
  }

  // ─── Step 4: Default Fallback to Normal ───
  return "low";
}

/**
 * Returns visual styling configuration for a given violence level.
 */
export function getViolenceConfig(level: ViolenceLevel): ViolenceConfig {
  switch (level) {
    case "high":
      return {
        level: "high",
        label: "High Threat",
        shortLabel: "High",
        color: "#ef4444",
        border: "rgba(239, 68, 68, 0.35)",
        bg: "rgba(239, 68, 68, 0.05)",
        badgeBg: "rgba(239, 68, 68, 0.15)",
        glow: "rgba(239, 68, 68, 0.4)",
        dotColor: "#ef4444"
      };
    case "medium":
      return {
        level: "medium",
        label: "Medium Threat",
        shortLabel: "Medium",
        color: "#f97316",
        border: "rgba(249, 115, 22, 0.35)",
        bg: "rgba(249, 115, 22, 0.05)",
        badgeBg: "rgba(249, 115, 22, 0.15)",
        glow: "rgba(249, 115, 22, 0.4)",
        dotColor: "#f97316"
      };
    case "low":
    default:
      return {
        level: "low",
        label: "Normal / Safe",
        shortLabel: "Normal",
        color: "#10b981",
        border: "rgba(16, 185, 129, 0.25)",
        bg: "rgba(16, 185, 129, 0.04)",
        badgeBg: "rgba(16, 185, 129, 0.15)",
        glow: "rgba(16, 185, 129, 0.4)",
        dotColor: "#10b981"
      };
  }
}
