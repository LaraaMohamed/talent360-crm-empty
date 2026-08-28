"""
Orchestrates the automated email-reply pipeline:
customer message -> LLM reply -> format -> save -> send -> log.
"""
from email_generator import EmailGenerator
from api_functions import format_email, save_email, send_email, log_action


def process_customer_message(generator: EmailGenerator, customer_message: str, recipient: str = "") -> dict:
    result = {"status": "failed", "email": None, "errors": []}

    try:
        reply_body = generator.generate_reply(customer_message)
    except ValueError as e:
        result["errors"].append(str(e))
        log_action("GENERATE_FAILED", str(e))
        return result

    try:
        email = format_email(recipient=recipient, subject="Re: Your inquiry", body=reply_body)
    except ValueError as e:
        result["errors"].append(str(e))
        log_action("FORMAT_FAILED", str(e))
        return result

    saved = save_email(email)
    if not saved:
        result["errors"].append("Failed to save email.")
        log_action("SAVE_FAILED", str(email))
        return result
    log_action("SAVED", email["subject"])

    sent = send_email(email)
    if not sent:
        result["errors"].append("Failed to send email.")
        log_action("SEND_FAILED", str(email))
        return result
    log_action("SENT", email["subject"])

    result["status"] = "success"
    result["email"] = email
    return result
