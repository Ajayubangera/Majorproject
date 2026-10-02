import os
import smtplib
import asyncio
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from datetime import datetime
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv

# Ensure environment variables are loaded
load_dotenv()

class EmailService:
    """
    Production-grade Alert Notification Dispatcher.
    Sends automated security alerts to team members configured in Access Management
    whenever unusual activity or security threats are verified and uploaded to cloud storage.
    """

    def __init__(self):
        self._load_config()

    def _load_config(self):
        self.smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com").strip()
        self.smtp_port = int(os.getenv("SMTP_PORT", "587"))
        self.smtp_user = os.getenv("SMTP_USER", "").strip()
        # Remove spaces in Google App Password (e.g. "daci zuoa pldm hbds" -> "dacizuoapldmhbds")
        self.smtp_password = os.getenv("SMTP_PASSWORD", "").replace(" ", "").strip()
        self.smtp_from_email = os.getenv("SMTP_FROM_EMAIL", "").strip() or self.smtp_user or "alerts@surveillance-ai.com"
        self.smtp_from_name = os.getenv("SMTP_FROM_NAME", "AI Surveillance Command Center").strip()
        self.smtp_use_tls = os.getenv("SMTP_USE_TLS", "true").lower() in ("true", "1", "yes")
        self.smtp_use_ssl = os.getenv("SMTP_USE_SSL", "false").lower() in ("true", "1", "yes") or self.smtp_port == 465
        self.app_base_url = os.getenv("APP_BASE_URL", "http://localhost:5173").rstrip("/")

    @property
    def is_configured(self) -> bool:
        """Returns True if valid SMTP credentials are configured in .env."""
        self._load_config()
        return bool(self.smtp_host and self.smtp_user and self.smtp_password)

    def get_status(self) -> Dict[str, Any]:
        self._load_config()
        return {
            "configured": self.is_configured,
            "smtp_host": self.smtp_host,
            "smtp_port": self.smtp_port,
            "sender_email": self.smtp_from_email,
            "sender_name": self.smtp_from_name,
            "use_tls": self.smtp_use_tls,
            "use_ssl": self.smtp_use_ssl,
            "app_base_url": self.app_base_url
        }

    def format_timestamp_display(self, ts: Optional[datetime] = None) -> Dict[str, str]:
        """Converts timestamp to facility local time (IST by default or from TIMEZONE env)
        along with UTC reference to eliminate date/time confusion."""
        import os
        from datetime import datetime, timezone
        
        tz_name = os.getenv("TIMEZONE") or os.getenv("FACILITY_TIMEZONE") or "Asia/Kolkata"
        target_tz = None
        try:
            from zoneinfo import ZoneInfo
            target_tz = ZoneInfo(tz_name.strip())
        except Exception:
            target_tz = datetime.now().astimezone().tzinfo

        # Normalize incoming timestamp
        if ts is None:
            dt_utc = datetime.now(timezone.utc)
        elif ts.tzinfo is None:
            # Naive datetime from DB or utcnow is UTC
            dt_utc = ts.replace(tzinfo=timezone.utc)
        else:
            dt_utc = ts.astimezone(timezone.utc)

        # Convert to local facility timezone
        dt_local = dt_utc.astimezone(target_tz)

        # Build readable strings
        local_date_str = dt_local.strftime("%A, %d %B %Y")
        local_time_str = dt_local.strftime("%I:%M:%S %p")
        tz_code = dt_local.tzname() or "Local Time"
        if "India" in tz_code or "IST" in tz_code or tz_name == "Asia/Kolkata":
            tz_badge = "IST (UTC+05:30)"
        else:
            offset = dt_local.strftime("%z")
            formatted_offset = f"UTC{offset[:3]}:{offset[3:]}" if offset else ""
            tz_badge = f"{tz_code} ({formatted_offset})" if formatted_offset else tz_code

        full_local = f"{local_date_str} at {local_time_str} {tz_badge}"
        utc_ref = dt_utc.strftime("%d %b %Y, %I:%M:%S %p UTC")

        return {
            "full_local": full_local,
            "local_date": local_date_str,
            "local_time": local_time_str,
            "tz_badge": tz_badge,
            "utc_ref": utc_ref,
            "combined": f"{full_local} (UTC: {utc_ref})"
        }

    def build_email_content(
        self,
        project_name: str,
        project_location: str,
        camera_name: str,
        camera_id: str,
        zone_tag: str,
        anomaly_type: str,
        threat_description: str,
        confidence_score: float,
        snapshot_url: str,
        timestamp: Optional[datetime] = None
    ) -> Dict[str, str]:
        """Formats the HTML and Plain Text alert templates with all incident details."""
        time_info = self.format_timestamp_display(timestamp)
        confidence_pct = f"{confidence_score * 100:.1f}%" if confidence_score <= 1.0 else f"{confidence_score:.1f}%"
        anomaly_display = anomaly_type.replace("_", " ").title()
        zone_display = zone_tag or "Monitored Zone"

        subject = f"🚨 [SECURITY ALERT] Unusual Activity Detected: {anomaly_display} - {camera_name} ({zone_display})"

        # HTML Template
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{subject}</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background-color: #080417;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
    }}
    .container {{
      max-width: 620px;
      margin: 20px auto;
      background: #0f0a26;
      border: 1px solid #2d225a;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
    }}
    .header {{
      background: linear-gradient(135deg, #e11d48 0%, #9333ea 100%);
      padding: 24px;
      text-align: center;
    }}
    .header h1 {{
      margin: 0;
      color: #ffffff;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }}
    .badge {{
      display: inline-block;
      margin-top: 8px;
      padding: 4px 12px;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      color: #ffd1dc;
      letter-spacing: 0.5px;
    }}
    .content {{
      padding: 24px;
    }}
    .alert-summary {{
      background: rgba(225, 29, 72, 0.12);
      border-left: 4px solid #e11d48;
      padding: 14px 18px;
      border-radius: 6px;
      margin-bottom: 24px;
      font-size: 14px;
      line-height: 1.5;
      color: #fecdd3;
    }}
    .details-table {{
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      font-size: 13px;
    }}
    .details-table td {{
      padding: 10px 12px;
      border-bottom: 1px solid #1f1742;
    }}
    .details-table td.label {{
      width: 38%;
      color: #94a3b8;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
    }}
    .details-table td.value {{
      color: #ffffff;
      font-weight: 500;
    }}
    .confidence-tag {{
      display: inline-block;
      padding: 2px 8px;
      background: #7c3aed;
      color: #ffffff;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
    }}
    .snapshot-box {{
      margin: 20px 0;
      background: #090518;
      border: 1px solid #2d225a;
      border-radius: 8px;
      overflow: hidden;
      text-align: center;
    }}
    .snapshot-header {{
      background: #140d33;
      padding: 8px 14px;
      font-size: 12px;
      color: #a78bfa;
      font-weight: 600;
      text-align: left;
      border-bottom: 1px solid #2d225a;
    }}
    .snapshot-box img {{
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }}
    .btn-container {{
      text-align: center;
      margin: 28px 0 16px 0;
    }}
    .btn {{
      display: inline-block;
      padding: 12px 28px;
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      border-radius: 6px;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
    }}
    .footer {{
      padding: 18px 24px;
      background: #0a061b;
      border-top: 1px solid #1f1742;
      text-align: center;
      font-size: 11px;
      color: #64748b;
      line-height: 1.6;
    }}
    .footer a {{
      color: #818cf8;
      text-decoration: none;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Security Alert Notification</h1>
      <div class="badge">Unusual Activity Verified by AI</div>
    </div>
    <div class="content">
      <div class="alert-summary">
        <strong>⚠️ Incident Detected:</strong> Unusual activity (<strong>{anomaly_display}</strong>) has been flagged by edge analytics and verified at <strong>{zone_display}</strong>.
      </div>

      <table class="details-table">
        <tr>
          <td class="label">Incident Type</td>
          <td class="value"><span style="color: #f43f5e; font-weight: 700;">{anomaly_display}</span></td>
        </tr>
        <tr>
          <td class="label">Camera Name</td>
          <td class="value">{camera_name}</td>
        </tr>
        <tr>
          <td class="label">Camera ID</td>
          <td class="value" style="font-family: monospace; font-size: 11px; color: #cbd5e1;">{camera_id}</td>
        </tr>
        <tr>
          <td class="label">Monitored Area / Zone</td>
          <td class="value">{zone_display}</td>
        </tr>
        <tr>
          <td class="label">Workspace / Project</td>
          <td class="value">{project_name} ({project_location})</td>
        </tr>
        <tr>
          <td class="label">AI Confidence Score</td>
          <td class="value"><span class="confidence-tag">{confidence_pct}</span></td>
        </tr>
        <tr>
          <td class="label">AI Assessment</td>
          <td class="value">{threat_description}</td>
        </tr>
        <tr>
          <td class="label">Detection Date & Time</td>
          <td class="value">
            <div style="font-weight: 700; color: #ffffff; font-size: 13px;">{time_info["full_local"]}</div>
            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">UTC Reference: {time_info["utc_ref"]}</div>
          </td>
        </tr>
      </table>

      {f'''
      <div class="snapshot-box">
        <div class="snapshot-header">📷 Verified Threat Snapshot (Cloud S3 Storage)</div>
        <img src="{snapshot_url}" alt="Threat Snapshot" style="max-height: 340px; object-fit: cover; width: 100%;" />
        <div style="padding: 10px; font-size: 11px; color: #94a3b8; background: #0c0822;">
          Cloud S3 Artifact: <a href="{snapshot_url}" target="_blank" style="color: #38bdf8; text-decoration: underline;">Open Full Resolution Snapshot</a>
        </div>
      </div>
      ''' if snapshot_url else ''}

      <div class="btn-container">
        <a href="{self.app_base_url}/dashboard" class="btn" target="_blank">
          Open Surveillance Command Center
        </a>
      </div>
    </div>

    <div class="footer">
      This automated alert was dispatched to you because your email is registered in <strong>Access Management (Responders & Admins)</strong> for <em>{project_name}</em>.<br>
      AI-Powered Edge CCTV Surveillance & Gemini Verification Platform.
    </div>
  </div>
</body>
</html>"""

        # Plain-Text Template
        plain = f"""================================================================================
SECURITY ALERT NOTIFICATION - UNUSUAL ACTIVITY DETECTED
================================================================================

Anomalous behavior has been detected by edge vision analytics and verified:

- Incident Type:    {anomaly_display}
- Camera Name:      {camera_name}
- Camera ID:        {camera_id}
- Area / Zone:      {zone_display}
- Project:          {project_name} ({project_location})
- AI Confidence:    {confidence_pct}
- AI Assessment:    {threat_description}
- Detection Time:   {time_info["full_local"]}
- UTC Reference:    {time_info["utc_ref"]}

{f"- S3 Snapshot URL:  {snapshot_url}" if snapshot_url else ""}
- Command Center:   {self.app_base_url}/dashboard

This message was sent to registered Access Management team members.
Please review the surveillance dashboard immediately.
================================================================================
"""
        return {"subject": subject, "html": html, "plain": plain}

    def _send_smtp_sync(
        self,
        to_emails: List[str],
        subject: str,
        html_content: str,
        plain_content: str,
        image_data: Optional[bytes] = None
    ) -> bool:
        """Synchronous SMTP worker invoked via asyncio.to_thread."""
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{self.smtp_from_name} <{self.smtp_from_email}>"
        msg["To"] = ", ".join(to_emails)

        msg.attach(MIMEText(plain_content, "plain"))
        msg.attach(MIMEText(html_content, "html"))

        # Optional inline image attachment if available
        if image_data:
            try:
                img_part = MIMEImage(image_data, name="threat_snapshot.jpg")
                img_part.add_header("Content-Disposition", "inline", filename="threat_snapshot.jpg")
                msg.attach(img_part)
            except Exception as img_err:
                print(f"[EmailService] Notice: Could not attach snapshot bytes: {img_err}")

        server = None
        try:
            if self.smtp_use_ssl:
                server = smtplib.SMTP_SSL(self.smtp_host, self.smtp_port, timeout=15)
            else:
                server = smtplib.SMTP(self.smtp_host, self.smtp_port, timeout=15)
                if self.smtp_use_tls:
                    server.starttls()

            if self.smtp_user and self.smtp_password:
                server.login(self.smtp_user, self.smtp_password)

            server.sendmail(self.smtp_from_email, to_emails, msg.as_string())
            print(f"[EmailService] Successfully sent security alert email to {len(to_emails)} recipients: {to_emails}")
            return True
        except Exception as e:
            print(f"[EmailService] Failed to send SMTP email to {to_emails}: {e}")
            return False
        finally:
            if server:
                try:
                    server.quit()
                except Exception:
                    pass

    async def send_alert_email(
        self,
        to_emails: List[str],
        project_name: str,
        project_location: str,
        camera_name: str,
        camera_id: str,
        zone_tag: str,
        anomaly_type: str,
        threat_description: str,
        confidence_score: float,
        snapshot_url: str,
        image_data: Optional[bytes] = None,
        timestamp: Optional[datetime] = None
    ) -> Dict[str, Any]:
        """
        Dispatches the alert email to all specified recipients.
        If SMTP is configured in .env, sends via real SMTP.
        If SMTP is not yet configured, cleanly logs and returns simulated delivery status.
        """
        if not to_emails:
            print("[EmailService] No recipient emails provided. Skipping alert dispatch.")
            return {"status": "skipped", "message": "No recipient emails provided", "recipients": []}

        # Clean and de-duplicate emails
        cleaned_emails = list(dict.fromkeys([e.strip() for e in to_emails if e and "@" in e]))
        if not cleaned_emails:
            print("[EmailService] No valid recipient emails found.")
            return {"status": "skipped", "message": "No valid emails", "recipients": []}

        email_data = self.build_email_content(
            project_name=project_name,
            project_location=project_location,
            camera_name=camera_name,
            camera_id=camera_id,
            zone_tag=zone_tag,
            anomaly_type=anomaly_type,
            threat_description=threat_description,
            confidence_score=confidence_score,
            snapshot_url=snapshot_url,
            timestamp=timestamp
        )

        if self.is_configured:
            print(f"[EmailService] Dispatching LIVE email to {cleaned_emails} via {self.smtp_host}:{self.smtp_port}...")
            success = await asyncio.to_thread(
                self._send_smtp_sync,
                cleaned_emails,
                email_data["subject"],
                email_data["html"],
                email_data["plain"],
                image_data
            )
            return {
                "status": "sent" if success else "failed",
                "mode": "live_smtp",
                "recipients": cleaned_emails,
                "subject": email_data["subject"],
                "snapshot_url": snapshot_url
            }
        else:
            safe_subject = str(email_data.get('subject', '')).encode('ascii', 'replace').decode('ascii')
            print("=" * 80)
            print("[EmailService SIMULATION] Live SMTP not configured in .env (SMTP_USER/SMTP_PASSWORD empty).")
            print("[EmailService SIMULATION] Dispatched alert notification to Access Management members:")
            print(f"  Recipients:   {cleaned_emails}")
            print(f"  Subject:      {safe_subject}")
            print(f"  Camera:       {camera_name} (ID: {camera_id})")
            print(f"  Area / Zone:  {zone_tag or 'Monitored Zone'}")
            print(f"  Project:      {project_name} ({project_location})")
            print(f"  Anomaly:      {anomaly_type} (Confidence: {confidence_score * 100:.1f}%)")
            print(f"  S3 Snapshot:  {snapshot_url}")
            print("  To enable real inbox delivery, configure SMTP_USER & SMTP_PASSWORD in .env")
            print("=" * 80)
            return {
                "status": "simulated",
                "mode": "simulation",
                "recipients": cleaned_emails,
                "subject": email_data["subject"],
                "snapshot_url": snapshot_url,
                "message": "Alert email formatted & logged (configure SMTP_USER in .env for live inbox delivery)"
            }

    async def notify_project_members_of_threat(
        self,
        project_id: str,
        camera_id: str,
        camera_name: str,
        zone_tag: str,
        anomaly_type: str,
        threat_description: str,
        confidence_score: float,
        snapshot_url: str,
        image_data: Optional[bytes] = None,
        timestamp: Optional[datetime] = None
    ) -> Dict[str, Any]:
        """
        Fetches all project members from the database (Access Management section)
        and sends the alert email with all details, area, camera, and S3 snapshot.
        """
        from database import AsyncSessionLocal, Project, ProjectMember
        from sqlalchemy import select

        project_name = "Security Workspace"
        project_location = "Facility"
        recipient_emails = []

        try:
            async with AsyncSessionLocal() as session:
                # Fetch project details
                proj_res = await session.execute(select(Project).where(Project.id == project_id))
                project = proj_res.scalar_one_or_none()
                if project:
                    project_name = project.name
                    project_location = project.location
                    if project.owner_id and "@" in project.owner_id:
                        recipient_emails.append(project.owner_id.strip())

                # Check camera allowed_members if camera_id is provided
                allowed_camera_members = None
                if camera_id:
                    from database import Camera
                    cam_res = await session.execute(select(Camera).where(Camera.id == camera_id))
                    cam_obj = cam_res.scalar_one_or_none()
                    if cam_obj and cam_obj.allowed_members:
                        try:
                            import json
                            parsed = json.loads(cam_obj.allowed_members) if isinstance(cam_obj.allowed_members, str) else cam_obj.allowed_members
                            if isinstance(parsed, list) and len(parsed) > 0 and "*" not in parsed and "all" not in parsed:
                                allowed_camera_members = set(m.lower().strip() for m in parsed)
                        except Exception:
                            pass

                # Fetch members in Access Management
                members_res = await session.execute(select(ProjectMember).where(ProjectMember.project_id == project_id))
                members = members_res.scalars().all()
                for m in members:
                    if m.email and "@" in m.email:
                        email_clean = m.email.strip().lower()
                        # Admins and workspace owner always receive threat alerts
                        if m.role == "admin" or (project and project.owner_id and project.owner_id.lower().strip() == email_clean):
                            recipient_emails.append(m.email.strip())
                        # If camera has specific allowed members, filter to those members or roles
                        elif allowed_camera_members is not None:
                            if email_clean in allowed_camera_members or m.role in allowed_camera_members:
                                recipient_emails.append(m.email.strip())
                        else:
                            recipient_emails.append(m.email.strip())

        except Exception as db_err:
            print(f"[EmailService] Error retrieving project members for alert: {db_err}")

        # De-duplicate
        recipient_emails = list(dict.fromkeys(recipient_emails))

        if not recipient_emails:
            print(f"[EmailService] No member emails found in Access Management for project {project_id}.")
            return {"status": "skipped", "message": "No Access Management members registered", "recipients": []}

        print(f"[EmailService] Found {len(recipient_emails)} email holder(s) in Access Management for project '{project_name}': {recipient_emails}")

        return await self.send_alert_email(
            to_emails=recipient_emails,
            project_name=project_name,
            project_location=project_location,
            camera_name=camera_name,
            camera_id=camera_id,
            zone_tag=zone_tag,
            anomaly_type=anomaly_type,
            threat_description=threat_description,
            confidence_score=confidence_score,
            snapshot_url=snapshot_url,
            image_data=image_data,
            timestamp=timestamp
        )

    def build_welcome_email_content(
        self,
        project_name: str,
        project_location: str,
        project_type: str,
        member_email: str,
        role: str
    ) -> Dict[str, str]:
        role_display = role.title()
        subject = f"🛡️ Access Granted: You have been added as {role_display} for {project_name}"

        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{subject}</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background-color: #080417;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
    }}
    .container {{
      max-width: 600px;
      margin: 20px auto;
      background: #0f0a26;
      border: 1px solid #2d225a;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
    }}
    .header {{
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      padding: 24px;
      text-align: center;
    }}
    .header h1 {{
      margin: 0;
      color: #ffffff;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.5px;
    }}
    .badge {{
      display: inline-block;
      margin-top: 8px;
      padding: 4px 12px;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      color: #e0e7ff;
    }}
    .content {{
      padding: 24px;
    }}
    .welcome-card {{
      background: rgba(79, 70, 229, 0.12);
      border-left: 4px solid #6366f1;
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 24px;
      font-size: 14px;
      line-height: 1.5;
      color: #e0e7ff;
    }}
    .details-table {{
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      font-size: 13px;
    }}
    .details-table td {{
      padding: 10px 12px;
      border-bottom: 1px solid #1f1742;
    }}
    .details-table td.label {{
      width: 35%;
      color: #94a3b8;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
    }}
    .details-table td.value {{
      color: #ffffff;
      font-weight: 500;
    }}
    .role-tag {{
      display: inline-block;
      padding: 3px 10px;
      background: #0284c7;
      color: #ffffff;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }}
    .alert-feature-box {{
      background: #130c33;
      border: 1px solid #2d225a;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }}
    .alert-feature-box h4 {{
      margin: 0 0 8px 0;
      color: #38bdf8;
      font-size: 13px;
    }}
    .alert-feature-box p {{
      margin: 0;
      font-size: 12px;
      color: #cbd5e1;
      line-height: 1.5;
    }}
    .btn-container {{
      text-align: center;
      margin: 24px 0 16px 0;
    }}
    .btn {{
      display: inline-block;
      padding: 12px 28px;
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      border-radius: 6px;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
    }}
    .footer {{
      padding: 18px 24px;
      background: #0a061b;
      border-top: 1px solid #1f1742;
      text-align: center;
      font-size: 11px;
      color: #64748b;
      line-height: 1.6;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Access Granted</h1>
      <div class="badge">Security Workspace Enrollment</div>
    </div>
    <div class="content">
      <div class="welcome-card">
        <strong>Hello,</strong> you have been granted access to the security surveillance management system for <strong>{project_name}</strong>.
      </div>

      <table class="details-table">
        <tr>
          <td class="label">Assigned Role</td>
          <td class="value"><span class="role-tag">{role_display}</span></td>
        </tr>
        <tr>
          <td class="label">Registered Email</td>
          <td class="value">{member_email}</td>
        </tr>
        <tr>
          <td class="label">Workspace / Project</td>
          <td class="value">{project_name}</td>
        </tr>
        <tr>
          <td class="label">Facility Location</td>
          <td class="value">{project_location}</td>
        </tr>
        <tr>
          <td class="label">Facility Category</td>
          <td class="value" style="text-transform: capitalize;">{project_type}</td>
        </tr>
      </table>

      <div class="alert-feature-box">
        <h4>🔔 Automated AI Threat Alerts Active</h4>
        <p>
          As an active team member, your email will receive instant alert notifications with high-resolution cloud S3 snapshots whenever an unusual activity (such as violence, intrusion, loitering, or fire) is verified by AI analytics.
        </p>
      </div>

      <div class="btn-container">
        <a href="{self.app_base_url}/dashboard" class="btn" target="_blank">
          Open Command Center Dashboard
        </a>
      </div>
    </div>

    <div class="footer">
      AI-Powered Edge CCTV Surveillance & Gemini Verification Platform.<br>
      You are receiving this message because an administrator added your email in Access Management.
    </div>
  </div>
</body>
</html>"""

        plain = f"""================================================================================
SECURITY WORKSPACE ACCESS GRANTED
================================================================================

Hello,

You have been granted access to:
- Project:      {project_name} ({project_location})
- Facility:     {project_type.title()}
- Role:         {role_display}
- Member Email: {member_email}

As a registered member in Access Management, your email will automatically
receive incident alerts with camera details, area tags, and cloud S3 snapshots
whenever unusual activity is verified by AI.

Command Center: {self.app_base_url}/dashboard
================================================================================
"""
        return {"subject": subject, "html": html, "plain": plain}

    async def send_member_welcome_email(
        self,
        member_email: str,
        role: str,
        project_name: str,
        project_location: str,
        project_type: str
    ) -> Dict[str, Any]:
        """Sends an access granted confirmation email to a newly added member."""
        if not member_email or "@" not in member_email:
            return {"status": "skipped", "message": "Invalid email address"}

        content = self.build_welcome_email_content(
            project_name=project_name,
            project_location=project_location,
            project_type=project_type,
            member_email=member_email,
            role=role
        )

        cleaned_emails = [member_email.strip()]

        if self.is_configured:
            print(f"[EmailService] Dispatching LIVE welcome email to {cleaned_emails} via {self.smtp_host}...")
            success = await asyncio.to_thread(
                self._send_smtp_sync,
                cleaned_emails,
                content["subject"],
                content["html"],
                content["plain"],
                None
            )
            return {
                "status": "sent" if success else "failed",
                "mode": "live_smtp",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }
        else:
            safe_subject = str(content.get('subject', '')).encode('ascii', 'replace').decode('ascii')
            print("=" * 80)
            print("[EmailService SIMULATION] Live SMTP not configured in .env (SMTP_USER empty).")
            print(f"[EmailService SIMULATION] Access Granted notification dispatched to new member:")
            print(f"  Recipient:    {cleaned_emails}")
            print(f"  Subject:      {safe_subject}")
            print(f"  Role:         {role}")
            print(f"  Project:      {project_name} ({project_location})")
            print("  To enable real inbox delivery, configure SMTP_USER & SMTP_PASSWORD in .env")
            print("=" * 80)
            return {
                "status": "simulated",
                "mode": "simulation",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }

    def build_role_change_email_content(
        self,
        project_name: str,
        project_location: str,
        member_email: str,
        old_role: str,
        new_role: str
    ) -> Dict[str, str]:
        old_display = old_role.title()
        new_display = new_role.title()
        subject = f"[ACCESS UPDATE] Permission Changed: Your role in {project_name} changed to {new_display}"

        role_desc = ""
        if new_role.lower() == "responder":
            role_desc = "As a <strong>Responder</strong>, you can acknowledge and resolve active security incidents. You will receive real-time email alerts with cloud S3 snapshots whenever unusual activity is verified by AI."
        elif new_role.lower() == "admin":
            role_desc = "As an <strong>Admin</strong>, you have full control over camera configurations, access management, and incident resolution, plus automated S3 threat email alerts."
        else:
            role_desc = "As a <strong>Viewer</strong>, you have read-only access to live surveillance streams. Tactical threat alert emails are restricted to Responders and Admins."

        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{subject}</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background-color: #080417;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
    }}
    .container {{
      max-width: 600px;
      margin: 20px auto;
      background: #0f0a26;
      border: 1px solid #2d225a;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
    }}
    .header {{
      background: linear-gradient(135deg, #0284c7 0%, #6366f1 100%);
      padding: 24px;
      text-align: center;
    }}
    .header h1 {{
      margin: 0;
      color: #ffffff;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.5px;
    }}
    .badge {{
      display: inline-block;
      margin-top: 8px;
      padding: 4px 12px;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      color: #bae6fd;
    }}
    .content {{
      padding: 24px;
    }}
    .notice-card {{
      background: rgba(2, 132, 199, 0.12);
      border-left: 4px solid #0284c7;
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 24px;
      font-size: 14px;
      line-height: 1.5;
      color: #bae6fd;
    }}
    .details-table {{
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      font-size: 13px;
    }}
    .details-table td {{
      padding: 10px 12px;
      border-bottom: 1px solid #1f1742;
    }}
    .details-table td.label {{
      width: 35%;
      color: #94a3b8;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
    }}
    .details-table td.value {{
      color: #ffffff;
      font-weight: 500;
    }}
    .role-badge {{
      display: inline-block;
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }}
    .old-role {{
      background: rgba(255, 255, 255, 0.08);
      color: #94a3b8;
      text-decoration: line-through;
    }}
    .new-role {{
      background: #0284c7;
      color: #ffffff;
    }}
    .permissions-box {{
      background: #130c33;
      border: 1px solid #2d225a;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
      font-size: 13px;
      line-height: 1.5;
      color: #cbd5e1;
    }}
    .btn-container {{
      text-align: center;
      margin: 24px 0 16px 0;
    }}
    .btn {{
      display: inline-block;
      padding: 12px 28px;
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      border-radius: 6px;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
    }}
    .footer {{
      padding: 18px 24px;
      background: #0a061b;
      border-top: 1px solid #1f1742;
      text-align: center;
      font-size: 11px;
      color: #64748b;
      line-height: 1.6;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Permission Update</h1>
      <div class="badge">Workspace Access Management</div>
    </div>
    <div class="content">
      <div class="notice-card">
        <strong>Notice:</strong> Your access permissions for <strong>{project_name}</strong> have been updated by an administrator.
      </div>

      <table class="details-table">
        <tr>
          <td class="label">Member Email</td>
          <td class="value">{member_email}</td>
        </tr>
        <tr>
          <td class="label">Workspace / Facility</td>
          <td class="value">{project_name} ({project_location})</td>
        </tr>
        <tr>
          <td class="label">Previous Role</td>
          <td class="value"><span class="role-badge old-role">{old_display}</span></td>
        </tr>
        <tr>
          <td class="label">Updated Role</td>
          <td class="value"><span class="role-badge new-role">{new_display}</span></td>
        </tr>
      </table>

      <div class="permissions-box">
        {role_desc}
      </div>

      <div class="btn-container">
        <a href="{self.app_base_url}/dashboard" class="btn" target="_blank">
          Open Surveillance Command Center
        </a>
      </div>
    </div>

    <div class="footer">
      AI-Powered Edge CCTV Surveillance & Gemini Verification Platform.<br>
      This notice was automatically dispatched to confirm your access role adjustment.
    </div>
  </div>
</body>
</html>"""

        plain = f"""================================================================================
WORKSPACE PERMISSION UPDATE
================================================================================

Your role in {project_name} ({project_location}) has been updated:

- Member Email:  {member_email}
- Previous Role: {old_display}
- Updated Role:  {new_display}

{role_desc.replace('<strong>', '').replace('</strong>', '')}

Command Center: {self.app_base_url}/dashboard
================================================================================
"""
        return {"subject": subject, "html": html, "plain": plain}

    async def send_role_change_email(
        self,
        member_email: str,
        old_role: str,
        new_role: str,
        project_name: str,
        project_location: str
    ) -> Dict[str, Any]:
        """Dispatches an email notification when a member's role is updated."""
        if not member_email or "@" not in member_email:
            return {"status": "skipped", "message": "Invalid email"}

        content = self.build_role_change_email_content(
            project_name=project_name,
            project_location=project_location,
            member_email=member_email,
            old_role=old_role,
            new_role=new_role
        )

        cleaned_emails = [member_email.strip()]

        if self.is_configured:
            print(f"[EmailService] Dispatching LIVE role update email to {cleaned_emails} via {self.smtp_host}...")
            success = await asyncio.to_thread(
                self._send_smtp_sync,
                cleaned_emails,
                content["subject"],
                content["html"],
                content["plain"],
                None
            )
            return {
                "status": "sent" if success else "failed",
                "mode": "live_smtp",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }
        else:
            safe_subject = str(content.get('subject', '')).encode('ascii', 'replace').decode('ascii')
            print("=" * 80)
            print("[EmailService SIMULATION] Live SMTP not configured in .env.")
            print(f"[EmailService SIMULATION] Role Change notification dispatched:")
            print(f"  Recipient:     {cleaned_emails}")
            print(f"  Subject:       {safe_subject}")
            print(f"  Role Change:   {old_role} -> {new_role}")
            print(f"  Project:       {project_name} ({project_location})")
            print("=" * 80)
            return {
                "status": "simulated",
                "mode": "simulation",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }

    def build_member_removed_email_content(
        self,
        project_name: str,
        project_location: str,
        member_email: str,
        role: str
    ) -> Dict[str, str]:
        role_display = role.title() if role else "Member"
        subject = f"[ACCESS REVOKED] Workspace Access Removed: {project_name}"

        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{subject}</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background-color: #080417;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
    }}
    .container {{
      max-width: 600px;
      margin: 20px auto;
      background: #0f0a26;
      border: 1px solid #3b1d36;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
    }}
    .header {{
      background: linear-gradient(135deg, #ef4444 0%, #991b1b 100%);
      padding: 24px;
      text-align: center;
    }}
    .header h1 {{
      margin: 0;
      color: #ffffff;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.5px;
    }}
    .badge {{
      display: inline-block;
      margin-top: 8px;
      padding: 4px 12px;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      color: #fecaca;
    }}
    .content {{
      padding: 24px;
    }}
    .notice-card {{
      background: rgba(239, 68, 68, 0.12);
      border-left: 4px solid #ef4444;
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 24px;
      font-size: 14px;
      line-height: 1.5;
      color: #fca5a5;
    }}
    .details-table {{
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #23194a;
    }}
    .details-table td {{
      padding: 12px 16px;
      border-bottom: 1px solid #1f1742;
      font-size: 13px;
    }}
    .details-table tr:last-child td {{
      border-bottom: none;
    }}
    .label {{
      color: #94a3b8;
      width: 40%;
      font-weight: 600;
    }}
    .value {{
      color: #ffffff;
      font-weight: 500;
    }}
    .status-badge {{
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.4);
    }}
    .revoked-info-box {{
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid #281d52;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }}
    .revoked-info-box h4 {{
      margin: 0 0 10px 0;
      color: #e2e8f0;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
    }}
    .revoked-info-box ul {{
      margin: 0;
      padding-left: 20px;
      color: #94a3b8;
      font-size: 12px;
      line-height: 1.7;
    }}
    .footer {{
      background: #090518;
      padding: 16px 24px;
      text-align: center;
      border-top: 1px solid #1f1742;
      font-size: 11px;
      color: #64748b;
      line-height: 1.6;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Access Revoked</h1>
      <div class="badge">Removed by Administrator</div>
    </div>
    <div class="content">
      <div class="notice-card">
        <strong>Notice:</strong> You were removed from <strong>{project_name}</strong> by an administrator. You no longer have access to this workspace or its live surveillance feeds.
      </div>

      <table class="details-table">
        <tr>
          <td class="label">Member Email</td>
          <td class="value">{member_email}</td>
        </tr>
        <tr>
          <td class="label">Workspace / Project</td>
          <td class="value">{project_name} ({project_location})</td>
        </tr>
        <tr>
          <td class="label">Previous Role</td>
          <td class="value">{role_display}</td>
        </tr>
        <tr>
          <td class="label">Access Status</td>
          <td class="value"><span class="status-badge">Access Revoked (No Access)</span></td>
        </tr>
      </table>

      <div class="revoked-info-box">
        <h4>🔒 What This Means</h4>
        <ul>
          <li>You no longer have permissions to view live CCTV camera streams or project dashboards.</li>
          <li>You will no longer receive automated security incident or AI threat alert notifications.</li>
          <li>If you believe this removal was done in error, please reach out to your project administrator.</li>
        </ul>
      </div>
    </div>

    <div class="footer">
      AI-Powered Edge CCTV Surveillance & Gemini Verification Platform.<br>
      This notification was automatically sent to confirm that your workspace access has been removed.
    </div>
  </div>
</body>
</html>"""

        plain = f"""================================================================================
WORKSPACE ACCESS REVOKED
================================================================================

Notice: You were removed from '{project_name}' by an administrator.
You no longer have access to this project, its surveillance camera streams, or incident alerts.

- Member Email:        {member_email}
- Workspace / Project: {project_name} ({project_location})
- Previous Role:       {role_display}
- Access Status:       Access Revoked (No Access)

What this means:
- You no longer have permissions to view live CCTV camera streams or project dashboards.
- You will no longer receive automated security incident or AI threat alert notifications.
- If you believe this removal was made in error, please reach out to your workspace administrator.

================================================================================
"""
        return {"subject": subject, "html": html, "plain": plain}

    async def send_member_removed_email(
        self,
        member_email: str,
        role: str,
        project_name: str,
        project_location: str
    ) -> Dict[str, Any]:
        """Dispatches an email notification when a member is removed from a workspace."""
        if not member_email or "@" not in member_email:
            return {"status": "skipped", "message": "Invalid email"}

        content = self.build_member_removed_email_content(
            project_name=project_name,
            project_location=project_location,
            member_email=member_email,
            role=role
        )

        cleaned_emails = [member_email.strip()]

        if self.is_configured:
            print(f"[EmailService] Dispatching LIVE removal email to {cleaned_emails} via {self.smtp_host}...")
            success = await asyncio.to_thread(
                self._send_smtp_sync,
                cleaned_emails,
                content["subject"],
                content["html"],
                content["plain"],
                None
            )
            return {
                "status": "sent" if success else "failed",
                "mode": "live_smtp",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }
        else:
            safe_subject = str(content.get('subject', '')).encode('ascii', 'replace').decode('ascii')
            print("=" * 80)
            print("[EmailService SIMULATION] Live SMTP not configured in .env.")
            print(f"[EmailService SIMULATION] Access Revocation notification dispatched:")
            print(f"  Recipient:     {cleaned_emails}")
            print(f"  Subject:       {safe_subject}")
            print(f"  Previous Role: {role}")
            print(f"  Project:       {project_name} ({project_location})")
            print("=" * 80)
            return {
                "status": "simulated",
                "mode": "simulation",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }

    def build_camera_access_email_content(
        self,
        project_name: str,
        project_location: str,
        member_email: str,
        granted_cameras: List[Dict[str, str]],
        total_project_cameras: int
    ) -> Dict[str, str]:
        count = len(granted_cameras)
        subject = f"[ACCESS UPDATE] Camera Access Granted: {count} feed(s) in {project_name}"

        camera_rows_html = ""
        for idx, cam in enumerate(granted_cameras, 1):
            cam_name = cam.get("name", f"Camera {idx}")
            cam_zone = cam.get("zone_tag") or "General Area"
            camera_rows_html += f"""
            <tr>
              <td style="padding: 12px 14px; border-bottom: 1px solid #1f1742; font-weight: 600; color: #ffffff;">
                📹 {cam_name}
              </td>
              <td style="padding: 12px 14px; border-bottom: 1px solid #1f1742; color: #38bdf8;">
                📍 {cam_zone}
              </td>
              <td style="padding: 12px 14px; border-bottom: 1px solid #1f1742; text-align: right;">
                <span style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700;">
                  ACTIVE ACCESS
                </span>
              </td>
            </tr>
            """

        camera_rows_plain = ""
        for idx, cam in enumerate(granted_cameras, 1):
            cam_name = cam.get("name", f"Camera {idx}")
            cam_zone = cam.get("zone_tag") or "General Area"
            camera_rows_plain += f"  - Camera {idx}: {cam_name} (Zone: {cam_zone}) [AUTHORIZED]\n"

        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{subject}</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background-color: #080417;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
    }}
    .container {{
      max-width: 600px;
      margin: 20px auto;
      background: #0f0a26;
      border: 1px solid #2d225a;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
    }}
    .header {{
      background: linear-gradient(135deg, #0284c7 0%, #6366f1 100%);
      padding: 24px;
      text-align: center;
    }}
    .header h1 {{
      margin: 0;
      color: #ffffff;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.5px;
    }}
    .badge {{
      display: inline-block;
      margin-top: 8px;
      padding: 4px 12px;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      color: #bae6fd;
    }}
    .content {{
      padding: 24px;
    }}
    .notice-card {{
      background: rgba(2, 132, 199, 0.12);
      border-left: 4px solid #0284c7;
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 24px;
      font-size: 14px;
      line-height: 1.5;
      color: #bae6fd;
    }}
    .scope-box {{
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.3);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 24px;
      font-size: 13px;
      color: #fef3c7;
      line-height: 1.5;
    }}
    .cameras-table {{
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      font-size: 13px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid #1f1742;
      border-radius: 8px;
      overflow: hidden;
    }}
    .cameras-table th {{
      background: rgba(255, 255, 255, 0.05);
      padding: 10px 14px;
      text-align: left;
      font-size: 11px;
      text-transform: uppercase;
      color: #94a3b8;
      border-bottom: 1px solid #1f1742;
    }}
    .btn-container {{
      text-align: center;
      margin: 28px 0 16px 0;
    }}
    .btn {{
      display: inline-block;
      padding: 12px 28px;
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      border-radius: 6px;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
    }}
    .footer {{
      padding: 18px 24px;
      background: #0a061b;
      border-top: 1px solid #1f1742;
      text-align: center;
      font-size: 11px;
      color: #64748b;
      line-height: 1.6;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Camera Access Permissions</h1>
      <div class="badge">Workspace Surveillance Management</div>
    </div>
    <div class="content">
      <div class="notice-card">
        <strong>Notice:</strong> Your camera viewing and threat monitoring permissions for <strong>{project_name}</strong> ({project_location}) have been updated by an administrator.
      </div>

      <div class="scope-box">
        <strong>🔒 Exclusive Access Scope:</strong> You have been granted access to only the <strong>{count}</strong> selected camera feed(s) listed below. Access to all other camera feeds in this workspace has been restricted.
      </div>

      <table class="cameras-table">
        <thead>
          <tr>
            <th>Camera Feed</th>
            <th>Zone / Location</th>
            <th style="text-align: right;">Access Status</th>
          </tr>
        </thead>
        <tbody>
          {camera_rows_html}
        </tbody>
      </table>

      <div class="btn-container">
        <a href="{self.app_base_url}/dashboard" class="btn" target="_blank">
          Open Surveillance Command Center
        </a>
      </div>
      <p style="text-align: center; font-size: 12px; color: #94a3b8; margin-top: 8px;">
        Log in to your command center dashboard to view your authorized live surveillance streams.
      </p>
    </div>

    <div class="footer">
      AI-Powered Edge CCTV Surveillance & Gemini Verification Platform.<br>
      This notice was automatically dispatched to confirm your assigned camera feed access.
    </div>
  </div>
</body>
</html>"""

        plain = f"""================================================================================
WORKSPACE CAMERA ACCESS PERMISSION UPDATE
================================================================================

Your camera viewing and monitoring access for {project_name} ({project_location})
has been updated by an administrator.

MEMBER EMAIL: {member_email}

AUTHORIZED CAMERA FEEDS ({count}):
{camera_rows_plain}
ACCESS SCOPE NOTICE:
You have been granted access to ONLY the {count} selected camera feed(s) listed above.
Access to all other camera feeds in this facility has been restricted.

To view your authorized live streams and monitored alerts, log in to your dashboard:
{self.app_base_url}/dashboard
================================================================================
"""
        return {"subject": subject, "html": html, "plain": plain}

    async def send_camera_access_update_email(
        self,
        member_email: str,
        project_name: str,
        project_location: str,
        granted_cameras: List[Dict[str, str]],
        total_project_cameras: int
    ) -> Dict[str, Any]:
        """Dispatches an email notification when camera access permissions are specifically assigned to a member."""
        if not member_email or "@" not in member_email:
            return {"status": "skipped", "message": "Invalid email"}

        content = self.build_camera_access_email_content(
            project_name=project_name,
            project_location=project_location,
            member_email=member_email,
            granted_cameras=granted_cameras,
            total_project_cameras=total_project_cameras
        )

        cleaned_emails = [member_email.strip()]

        if self.is_configured:
            print(f"[EmailService] Dispatching LIVE camera access email to {cleaned_emails} via {self.smtp_host}...")
            success = await asyncio.to_thread(
                self._send_smtp_sync,
                cleaned_emails,
                content["subject"],
                content["html"],
                content["plain"],
                None
            )
            return {
                "status": "sent" if success else "failed",
                "mode": "live_smtp",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }
        else:
            safe_subject = str(content.get('subject', '')).encode('ascii', 'replace').decode('ascii')
            print("=" * 80)
            print("[EmailService SIMULATION] Live SMTP not configured in .env.")
            print(f"[EmailService SIMULATION] Camera Access notification dispatched:")
            print(f"  Recipient:       {cleaned_emails}")
            print(f"  Subject:         {safe_subject}")
            print(f"  Granted Cameras: {[c.get('name') for c in granted_cameras]}")
            print(f"  Project:         {project_name} ({project_location})")
            print("=" * 80)
            return {
                "status": "simulated",
                "mode": "simulation",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }

    def build_account_welcome_email_content(
        self,
        full_name: str,
        email: str,
        organization_name: str
    ) -> Dict[str, str]:
        """Builds HTML and text content for a new user account registration welcome email."""
        subject = f"[Aegis Guard] Welcome {full_name} | Your Surveillance Account is Active"
        now_str = self.format_timestamp_display()["full_local"]

        html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Aegis Guard</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background-color: #050112;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
      -webkit-font-smoothing: antialiased;
    }}
    .container {{
      max-width: 620px;
      margin: 32px auto;
      background-color: #0d0722;
      border: 1px solid #23164b;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
    }}
    .header {{
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #06b6d4 100%);
      padding: 32px 28px;
      text-align: center;
    }}
    .header h1 {{
      margin: 0;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: #ffffff;
      text-transform: uppercase;
    }}
    .badge {{
      display: inline-block;
      margin-top: 10px;
      background: rgba(255, 255, 255, 0.22);
      border: 1px solid rgba(255, 255, 255, 0.4);
      padding: 4px 14px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #ffffff;
    }}
    .content {{
      padding: 28px;
    }}
    .welcome-card {{
      background: #140d33;
      border-left: 4px solid #6366f1;
      padding: 16px 20px;
      border-radius: 6px;
      margin-bottom: 24px;
      font-size: 15px;
      line-height: 1.6;
      color: #f1f5f9;
    }}
    .details-table {{
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      background: #11092b;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #1e1345;
    }}
    .details-table tr:not(:last-child) {{
      border-bottom: 1px solid #1e1345;
    }}
    .details-table td {{
      padding: 12px 18px;
      font-size: 13px;
    }}
    .details-table .label {{
      color: #94a3b8;
      width: 38%;
      font-weight: 600;
    }}
    .details-table .value {{
      color: #f8fafc;
      font-weight: 600;
    }}
    .status-tag {{
      display: inline-block;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      background: rgba(34, 197, 94, 0.2);
      border: 1px solid #22c55e;
      color: #4ade80;
      text-transform: uppercase;
    }}
    .features-card {{
      background: #130c33;
      border: 1px solid #2d225a;
      border-radius: 8px;
      padding: 18px 20px;
      margin-bottom: 24px;
    }}
    .features-card h4 {{
      margin: 0 0 12px 0;
      color: #38bdf8;
      font-size: 14px;
      letter-spacing: 0.5px;
    }}
    .features-list {{
      margin: 0;
      padding-left: 20px;
      font-size: 12px;
      color: #cbd5e1;
      line-height: 1.8;
    }}
    .features-list li strong {{
      color: #f8fafc;
    }}
    .btn-container {{
      text-align: center;
      margin: 28px 0 16px 0;
    }}
    .btn {{
      display: inline-block;
      padding: 13px 32px;
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      border-radius: 8px;
      box-shadow: 0 4px 18px rgba(99, 102, 241, 0.45);
      letter-spacing: 0.5px;
    }}
    .footer {{
      padding: 20px 24px;
      background: #0a061b;
      border-top: 1px solid #1f1742;
      text-align: center;
      font-size: 11px;
      color: #64748b;
      line-height: 1.6;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Aegis Guard</h1>
      <div class="badge">Account Activated</div>
    </div>
    <div class="content">
      <div class="welcome-card">
        <strong>Welcome, {full_name}!</strong> Your account and organizational gateway have been successfully provisioned on <strong>Aegis Guard</strong>.
      </div>

      <table class="details-table">
        <tr>
          <td class="label">Account Holder</td>
          <td class="value">{full_name}</td>
        </tr>
        <tr>
          <td class="label">Registered Email</td>
          <td class="value">{email}</td>
        </tr>
        <tr>
          <td class="label">Organization</td>
          <td class="value">{organization_name}</td>
        </tr>
        <tr>
          <td class="label">Account Status</td>
          <td class="value"><span class="status-tag">Active &amp; Operational</span></td>
        </tr>
        <tr>
          <td class="label">Activated At</td>
          <td class="value">{now_str}</td>
        </tr>
      </table>

      <div class="features-card">
        <h4>PLATFORM CAPABILITIES ACTIVATED:</h4>
        <ul class="features-list">
          <li><strong>Zero-Latency RTSP Stream Ingestion:</strong> Connect CCTV cameras, NVRs, and IP video sources with real-time hardware decoding.</li>
          <li><strong>Edge YOLOv8 Intelligence:</strong> Instant motion, person, loitering, and perimeter breach detection.</li>
          <li><strong>Multimodal Gemini Verification:</strong> Advanced cloud vision AI that analyzes flagged scenes to eradicate false alarms.</li>
          <li><strong>Automated S3 Snapshot Archive:</strong> Cloud-backed forensic evidence repository with instant alert emails.</li>
          <li><strong>Access Management:</strong> Role-based governance (Admin, Responder, Viewer) for your security response team.</li>
        </ul>
      </div>

      <div class="btn-container">
        <a href="{self.app_base_url}/dashboard" class="btn" target="_blank">
          Launch Command Center Dashboard
        </a>
      </div>
    </div>

    <div class="footer">
      Aegis Guard | AI-Powered Edge CCTV Surveillance &amp; Gemini Verification Platform.<br>
      You received this confirmation because this email was registered on the platform. If you did not create this account, please notify security administrators.
    </div>
  </div>
</body>
</html>"""

        plain = f"""================================================================================
WELCOME TO AEGIS GUARD
AI-POWERED CCTV SURVEILLANCE & VERIFICATION PLATFORM
================================================================================

Hello {full_name},

Your account has been successfully registered and activated on Aegis Guard!

Account Details:
- Name:         {full_name}
- Email:        {email}
- Organization: {organization_name}
- Status:       Active & Operational
- Activated:    {now_str}

Key Platform Features:
- Edge YOLOv8 AI Detection & Low-Latency RTSP Streaming
- Google Gemini 2.0 Multimodal Threat Verification
- Automated Cloud S3 Incident Snapshot Capture
- Role-based Access Management & Instant Threat Email Dispatches

Launch Command Center: {self.app_base_url}/dashboard
================================================================================
"""
        return {"subject": subject, "html": html, "plain": plain}

    async def send_account_welcome_email(
        self,
        full_name: str,
        email: str,
        organization_name: str
    ) -> Dict[str, Any]:
        """Dispatches a welcome email when a user registers a new account."""
        if not email or "@" not in email:
            return {"status": "skipped", "message": "Invalid email address"}

        content = self.build_account_welcome_email_content(
            full_name=full_name,
            email=email,
            organization_name=organization_name
        )

        cleaned_emails = [email.strip()]

        if self.is_configured:
            print(f"[EmailService] Dispatching LIVE registration welcome email to {cleaned_emails} via {self.smtp_host}...")
            success = await asyncio.to_thread(
                self._send_smtp_sync,
                cleaned_emails,
                content["subject"],
                content["html"],
                content["plain"],
                None
            )
            return {
                "status": "sent" if success else "failed",
                "mode": "live_smtp",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }
        else:
            safe_subject = str(content.get('subject', '')).encode('ascii', 'replace').decode('ascii')
            print("=" * 80)
            print("[EmailService SIMULATION] Live SMTP not configured in .env.")
            print(f"[EmailService SIMULATION] Account Registration Welcome dispatched:")
            print(f"  Recipient:    {cleaned_emails}")
            print(f"  Subject:      {safe_subject}")
            print(f"  Account User: {full_name} ({organization_name})")
            print("=" * 80)
            return {
                "status": "simulated",
                "mode": "simulation",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }

    def build_password_reset_email_content(
        self,
        full_name: str,
        email: str,
        reset_url: str
    ) -> Dict[str, str]:
        """Builds HTML and text content for a secure password reset request email."""
        subject = "[Aegis Guard] Password Reset Request"
        now_str = self.format_timestamp_display()["full_local"]

        html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background-color: #050112;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
      -webkit-font-smoothing: antialiased;
    }}
    .container {{
      max-width: 620px;
      margin: 32px auto;
      background-color: #0d0722;
      border: 1px solid #23164b;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
    }}
    .header {{
      background: linear-gradient(135deg, #ef4444 0%, #8b5cf6 50%, #4f46e5 100%);
      padding: 30px 28px;
      text-align: center;
    }}
    .header h1 {{
      margin: 0;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: #ffffff;
      text-transform: uppercase;
    }}
    .badge {{
      display: inline-block;
      margin-top: 8px;
      background: rgba(255, 255, 255, 0.22);
      border: 1px solid rgba(255, 255, 255, 0.4);
      padding: 4px 14px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #ffffff;
    }}
    .content {{
      padding: 28px;
    }}
    .notice-card {{
      background: #140d33;
      border-left: 4px solid #ef4444;
      padding: 16px 20px;
      border-radius: 6px;
      margin-bottom: 24px;
      font-size: 14px;
      line-height: 1.6;
      color: #f1f5f9;
    }}
    .details-table {{
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      background: #11092b;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #1e1345;
    }}
    .details-table tr:not(:last-child) {{
      border-bottom: 1px solid #1e1345;
    }}
    .details-table td {{
      padding: 12px 18px;
      font-size: 13px;
    }}
    .details-table .label {{
      color: #94a3b8;
      width: 38%;
      font-weight: 600;
    }}
    .details-table .value {{
      color: #f8fafc;
      font-weight: 600;
    }}
    .warning-box {{
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px;
      padding: 14px 18px;
      margin-bottom: 24px;
      font-size: 12px;
      color: #fca5a5;
      line-height: 1.6;
    }}
    .btn-container {{
      text-align: center;
      margin: 28px 0 20px 0;
    }}
    .btn {{
      display: inline-block;
      padding: 14px 34px;
      background: linear-gradient(135deg, #ef4444 0%, #8b5cf6 100%);
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 700;
      font-size: 14px;
      border-radius: 8px;
      box-shadow: 0 4px 18px rgba(239, 68, 68, 0.45);
      letter-spacing: 0.5px;
    }}
    .fallback-link {{
      font-size: 11px;
      color: #94a3b8;
      word-break: break-all;
      margin-top: 14px;
      text-align: center;
    }}
    .fallback-link a {{
      color: #818cf8;
    }}
    .footer {{
      padding: 20px 24px;
      background: #0a061b;
      border-top: 1px solid #1f1742;
      text-align: center;
      font-size: 11px;
      color: #64748b;
      line-height: 1.6;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Aegis Guard</h1>
      <div class="badge">Security Credentials Reset</div>
    </div>
    <div class="content">
      <div class="notice-card">
        <strong>Hello {full_name},</strong><br>
        We received a request to reset the password for your Aegis Guard surveillance account.
      </div>

      <table class="details-table">
        <tr>
          <td class="label">Account User</td>
          <td class="value">{full_name}</td>
        </tr>
        <tr>
          <td class="label">Registered Email</td>
          <td class="value">{email}</td>
        </tr>
        <tr>
          <td class="label">Link Expiration</td>
          <td class="value"><span style="color: #fbbf24; font-weight: 700;">30 Minutes</span></td>
        </tr>
        <tr>
          <td class="label">Request Time</td>
          <td class="value">{now_str}</td>
        </tr>
      </table>

      <div class="btn-container">
        <a href="{reset_url}" class="btn" target="_blank">
          Reset Your Password
        </a>
      </div>

      <div class="fallback-link">
        If the button above does not work, copy and paste this link in your browser:<br>
        <a href="{reset_url}">{reset_url}</a>
      </div>

      <div class="warning-box">
        <strong>Security Notice:</strong> This password reset link is valid for <strong>30 minutes</strong> and can only be used once. If you did not make this request, your account is still secure — simply ignore this email.
      </div>
    </div>

    <div class="footer">
      Aegis Guard | AI-Powered Edge CCTV Surveillance &amp; Incident Verification Platform.<br>
      Automated authentication alert generated on behalf of your surveillance workspace.
    </div>
  </div>
</body>
</html>"""

        plain = f"""================================================================================
AEGIS GUARD - PASSWORD RESET REQUEST
================================================================================

Hello {full_name},

We received a request to reset your password for Aegis Guard.

Click or copy the link below to set a new password (valid for 30 minutes):
{reset_url}

Request Details:
- Email:        {email}
- Expires in:   30 Minutes
- Requested at: {now_str}

If you did not request this password reset, please ignore this email.
Your current password remains unchanged.
================================================================================
"""
        return {"subject": subject, "html": html, "plain": plain}

    async def send_password_reset_email(
        self,
        full_name: str,
        email: str,
        reset_token: str
    ) -> Dict[str, Any]:
        """Dispatches a password reset link to the user's email."""
        if not email or "@" not in email:
            return {"status": "skipped", "message": "Invalid email address"}

        reset_url = f"{self.app_base_url}/auth?reset_token={reset_token}&email={email}"

        content = self.build_password_reset_email_content(
            full_name=full_name,
            email=email,
            reset_url=reset_url
        )

        cleaned_emails = [email.strip()]

        if self.is_configured:
            print(f"[EmailService] Dispatching LIVE password reset email to {cleaned_emails} via {self.smtp_host}...")
            success = await asyncio.to_thread(
                self._send_smtp_sync,
                cleaned_emails,
                content["subject"],
                content["html"],
                content["plain"],
                None
            )
            return {
                "status": "sent" if success else "failed",
                "mode": "live_smtp",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }
        else:
            safe_subject = str(content.get('subject', '')).encode('ascii', 'replace').decode('ascii')
            print("=" * 80)
            print("[EmailService SIMULATION] Live SMTP not configured in .env.")
            print(f"[EmailService SIMULATION] Password Reset Email dispatched:")
            print(f"  Recipient: {cleaned_emails}")
            print(f"  Subject:   {safe_subject}")
            print(f"  Reset URL: {reset_url}")
            print("=" * 80)
            return {
                "status": "simulated",
                "mode": "simulation",
                "recipients": cleaned_emails,
                "subject": content["subject"]
            }

# Global Singleton Instance
email_service = EmailService()

