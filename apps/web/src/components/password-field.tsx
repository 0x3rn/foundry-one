"use client";

import { ChangeEvent, useState } from "react";

interface PasswordFieldProps {
  readonly autoComplete: "current-password" | "new-password";
  readonly autoFocus?: boolean;
  readonly id: string;
  readonly label: string;
  readonly minLength?: number;
  readonly name: string;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly required?: boolean;
  readonly value: string;
}

export function PasswordField({
  autoComplete,
  autoFocus = false,
  id,
  label,
  minLength,
  name,
  onChange,
  required = false,
  value,
}: PasswordFieldProps) {
  const [isVisible, setIsVisible] = useState(false);
  const toggleLabel = isVisible ? "Hide password" : "Show password";

  return (
    <label htmlFor={id}>
      {label}
      <span className="foundry-password-field">
        <input
          id={id}
          name={name}
          type={isVisible ? "text" : "password"}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          value={value}
          onChange={onChange}
          required={required}
          minLength={minLength}
        />
        <button
          className="foundry-password-toggle"
          type="button"
          aria-label={toggleLabel}
          aria-pressed={isVisible}
          onClick={() => setIsVisible((visible) => !visible)}
        >
          {isVisible ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 3l18 18" />
              <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
              <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c5 0 8.7 4.4 9.8 7a17 17 0 0 1-3.2 4.3M6.2 6.2C3.9 7.7 2.6 10 2.2 12c1.1 2.6 4.8 7 9.8 7 1.2 0 2.4-.2 3.4-.7" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2.2 12c1.1-2.6 4.8-7 9.8-7s8.7 4.4 9.8 7c-1.1 2.6-4.8 7-9.8 7S3.3 14.6 2.2 12Z" />
              <circle cx="12" cy="12" r="2.6" />
            </svg>
          )}
        </button>
      </span>
    </label>
  );
}
