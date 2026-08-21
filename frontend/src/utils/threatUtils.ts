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
 * Determines the violence / threat level of an alert snapshot:
 * - 'high' (Red): Physical violence, fighting, combat, fire hazard, weapons, assault, or high-confidence AI threat detections (>= 75%).
 * - 'medium' (Orange): Loitering, trespassing, intrusion, running, phone use, or mid-confidence detections (25% - 75%).
 * - 'low' (Green): Normal monitoring scenario, clear environment, false positive filtered, or low confidence (< 25%).
 */
export function getViolenceLevel(alert: any): ViolenceLevel {
  if (!alert) return "low";

  const anomaly = (alert.anomaly_type || "").toLowerCase().trim();
  const desc = (alert.threat_description || "").toLowerCase().trim();
  const conf = typeof alert.confidence_score === "number" ? alert.confidence_score : 0;

  // 1. Explicit Normal / Safe check
  const isNormalText = 
    desc.includes("normal operational") || 
    desc.includes("normal monitoring") || 
    desc.includes("normal activity") || 
    desc.includes("clear environment") || 
    desc.includes("no active threat") || 
    desc.includes("false positive") || 
    desc.includes("no threat") ||
    desc.includes("clear scene");

  if (anomaly === "normal" || anomaly === "safe" || anomaly === "none" || (isNormalText && conf < 0.35)) {
    return "low";
  }

  // 2. High Violence / Severe Threat Keywords
  const highKeywords = [
    "violence", 
    "fighting", 
    "fight", 
    "combat", 
    "assault", 
    "attack", 
    "weapon", 
    "gun", 
    "knife", 
    "fire", 
    "thermal hazard", 
    "ignition", 
    "robbery", 
    "active combat", 
    "physical violence"
  ];
  const isHighAnomaly = highKeywords.some(k => anomaly.includes(k));
  const isHighDesc = highKeywords.some(k => desc.includes(k));

  if (isHighAnomaly || isHighDesc) {
    return "high";
  }

  // 3. Medium Violence / Suspicious Activity Keywords
  const mediumKeywords = [
    "loitering", 
    "trespassing", 
    "intrusion", 
    "climbing", 
    "running", 
    "phone_use", 
    "talking", 
    "looking_sideways", 
    "suspicious", 
    "unauthorized", 
    "abnormal", 
    "motionless", 
    "perimeter"
  ];
  const isMediumAnomaly = mediumKeywords.some(k => anomaly.includes(k));
  const isMediumDesc = mediumKeywords.some(k => desc.includes(k));

  if (isMediumAnomaly || isMediumDesc) {
    return "medium";
  }

  // 4. Fallback based on confidence score & status
  if (conf >= 0.75 && !isNormalText) {
    return "high";
  } else if (conf >= 0.25 && !isNormalText) {
    return "medium";
  }

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
        label: "High Violence",
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
        label: "Medium Violence",
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
        label: "No Violence",
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
