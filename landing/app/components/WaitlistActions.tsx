"use client";

import Script from "next/script";
import { FormEvent, useEffect, useRef, useState } from "react";
import styles from "./LandingPage.module.css";

declare const __TURNSTILE_SITE_KEY__: string;

const TURNSTILE_PLACEHOLDER_PATTERN = /replace|placeholder/iu;

type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function WaitlistActions() {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState(false);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const widgetNode = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const siteKey = __TURNSTILE_SITE_KEY__;
  const turnstileConfigured = siteKey.length > 0 && !TURNSTILE_PLACEHOLDER_PATTERN.test(siteKey);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/waitlist/status", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : { joined: false }))
      .then((result: { joined?: boolean }) => setJoined(result.joined === true))
      .catch(() => undefined)
      .finally(() => setChecking(false));
    return () => controller.abort();
  }, []);

  function renderTurnstile() {
    if (!turnstileConfigured || !widgetNode.current || !window.turnstile || widgetId.current) return;
    widgetId.current = window.turnstile.render(widgetNode.current, {
      sitekey: siteKey,
      action: "waitlist_signup",
      theme: "light",
      callback: (value: string) => {
        setToken(value);
        setMessage("");
      },
      "expired-callback": () => setToken(""),
      "error-callback": () => {
        setToken("");
        setMessage("The privacy check could not load. Please refresh and try again.");
      },
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || submitting) return;
    const honeypot = new FormData(event.currentTarget).get("website");
    setSubmitting(true);
    setMessage("");

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          turnstileToken: token,
          website: typeof honeypot === "string" ? honeypot : "",
        }),
      });

      if (!response.ok) {
        setMessage(
          response.status === 429
            ? "Too many attempts from this connection. Please wait a minute and try again."
            : response.status === 503
              ? "The waitlist is temporarily unavailable. Please try again shortly."
              : "We could not save that signup. Check the email and privacy check, then try again.",
        );
        setToken("");
        if (widgetId.current) window.turnstile?.reset(widgetId.current);
        return;
      }

      const result = (await response.json()) as { joined?: boolean };
      if (result.joined === true) setJoined(true);
      else setMessage("We could not confirm the signup. Please try again.");
    } catch {
      setMessage("The waitlist could not be reached. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return <p className={styles.waitlistState} role="status">Checking this browser’s waitlist ticket…</p>;
  }

  if (joined) {
    return (
      <div className={styles.joinedState} role="status">
        <span aria-hidden="true">✓</span>
        <div><strong>You’re on the waitlist.</strong><p>This browser will remember your ticket.</p></div>
      </div>
    );
  }

  return (
    <form className={styles.waitlistControls} onSubmit={submit} noValidate={false}>
      <label className={styles.emailField}>
        <span>Email address</span>
        <input
          type="email"
          name="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          inputMode="email"
          maxLength={254}
          placeholder="you@example.com"
          required
        />
      </label>
      <input className={styles.honeypot} type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
      {turnstileConfigured ? (
        <>
          <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" onReady={renderTurnstile} />
          <div className={styles.turnstile} ref={widgetNode} aria-label="Privacy verification" />
        </>
      ) : (
        <p className={styles.configurationNote}>Waitlist verification is not configured for this build.</p>
      )}
      <button className={styles.primaryAction} type="submit" disabled={!token || submitting}>
        {submitting ? "Saving your ticket…" : "Join the waitlist"}
        {!submitting ? <ArrowIcon /> : null}
      </button>
      <p className={styles.waitlistDisclosure}>One email and no conversation data. Duplicate signups are kept only once.</p>
      <p className={styles.formMessage} role="status" aria-live="polite">{message}</p>
    </form>
  );
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>;
}
