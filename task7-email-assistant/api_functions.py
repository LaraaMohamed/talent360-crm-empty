"""
API-like functions that simulate the backend automation steps of the
email workflow: formatting, saving, sending, and logging.
"""
import json
import os
from datetime import datetime, timezone

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
EMAILS_FILE = os.path.join(DATA_DIR, "sent_emails.json")
LOG_FILE = os.path.join(DATA_DIR, "email_log.txt")


def format_email(recipient: str, subject: str, body: str) -> dict:
    if not body or not body.strip():
        raise ValueError("Email body cannot be empty.")
    return {
        "recipient": recipient or "customer@example.com",
        "subject": subject or "Re: Your inquiry",
        "body": body.strip(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def save_email(email: dict, emails_file: str = EMAILS_FILE) -> bool:
    try:
        os.makedirs(os.path.dirname(emails_file), exist_ok=True)
        records = []
        if os.path.exists(emails_file):
            with open(emails_file, "r", encoding="utf-8") as f:
                records = json.load(f)
        records.append(email)
        with open(emails_file, "w", encoding="utf-8") as f:
            json.dump(records, f, indent=2)
        return True
    except OSError:
        return False


def send_email(email: dict) -> bool:
    """Simulates sending an email (no real network call)."""
    if not email.get("body"):
        return False
    print(f"[SIMULATED SEND] To: {email['recipient']} | Subject: {email['subject']}")
    return True


def log_action(action: str, details: str = "", log_file: str = LOG_FILE) -> None:
    os.makedirs(os.path.dirname(log_file), exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat()
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] {action}: {details}\n")
