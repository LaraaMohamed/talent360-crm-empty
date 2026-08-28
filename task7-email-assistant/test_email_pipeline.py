"""
Offline tests for the email assistant pipeline and its API-like functions.

Uses a fake generator (no model download needed) so the pipeline logic --
formatting, saving, sending, logging, and error handling -- can be verified
in any environment.

Run with:
    python test_email_pipeline.py
"""
import json
import os
import shutil
import tempfile

from email_generator import EmailGenerator
from api_functions import format_email, send_email
from pipeline import process_customer_message


def fake_llm(prompt: str) -> str:
    return "Dear customer, thank you for reaching out. We will resolve this shortly. Best regards, Support Team"


def test_format_email_rejects_empty_body():
    try:
        format_email("a@b.com", "Subject", "   ")
    except ValueError:
        print("PASS test_format_email_rejects_empty_body")
        return
    raise AssertionError("Expected ValueError for empty body")


def test_send_email_rejects_missing_body():
    assert send_email({"recipient": "a@b.com", "subject": "x", "body": ""}) is False
    print("PASS test_send_email_rejects_missing_body")


def test_pipeline_success_path():
    tmp_dir = tempfile.mkdtemp()
    try:
        emails_file = os.path.join(tmp_dir, "sent_emails.json")
        log_file = os.path.join(tmp_dir, "email_log.txt")
        generator = EmailGenerator(generator=fake_llm)

        result = process_customer_message(
            generator,
            "My order hasn't arrived yet.",
            recipient="jane@example.com",
            emails_file=emails_file,
            log_file=log_file,
        )

        assert result["status"] == "success", result
        assert result["email"]["recipient"] == "jane@example.com"
        assert os.path.exists(emails_file)
        with open(emails_file) as f:
            saved = json.load(f)
        assert len(saved) == 1
        assert os.path.exists(log_file)
        with open(log_file) as f:
            log_contents = f.read()
        assert "SAVED" in log_contents and "SENT" in log_contents
        print("PASS test_pipeline_success_path")
    finally:
        shutil.rmtree(tmp_dir)


def test_pipeline_handles_empty_input():
    tmp_dir = tempfile.mkdtemp()
    try:
        emails_file = os.path.join(tmp_dir, "sent_emails.json")
        log_file = os.path.join(tmp_dir, "email_log.txt")
        generator = EmailGenerator(generator=fake_llm)

        result = process_customer_message(generator, "   ", emails_file=emails_file, log_file=log_file)

        assert result["status"] == "failed"
        assert "empty" in result["errors"][0].lower()
        assert not os.path.exists(emails_file), "Nothing should be saved for empty input"
        with open(log_file) as f:
            assert "GENERATE_FAILED" in f.read()
        print("PASS test_pipeline_handles_empty_input")
    finally:
        shutil.rmtree(tmp_dir)


def test_pipeline_handles_failed_save():
    tmp_dir = tempfile.mkdtemp()
    try:
        # Force save_email to fail: make its parent path collide with a file
        blocked_file = os.path.join(tmp_dir, "not_a_dir")
        with open(blocked_file, "w") as f:
            f.write("x")
        emails_file = os.path.join(blocked_file, "sub", "sent_emails.json")
        log_file = os.path.join(tmp_dir, "email_log.txt")
        generator = EmailGenerator(generator=fake_llm)

        result = process_customer_message(
            generator, "Please help with my invoice.", emails_file=emails_file, log_file=log_file
        )

        assert result["status"] == "failed"
        assert "save" in result["errors"][0].lower()
        with open(log_file) as f:
            assert "SAVE_FAILED" in f.read()
        print("PASS test_pipeline_handles_failed_save")
    finally:
        shutil.rmtree(tmp_dir)


if __name__ == "__main__":
    test_format_email_rejects_empty_body()
    test_send_email_rejects_missing_body()
    test_pipeline_success_path()
    test_pipeline_handles_empty_input()
    test_pipeline_handles_failed_save()
    print("\nAll email assistant tests passed.")
