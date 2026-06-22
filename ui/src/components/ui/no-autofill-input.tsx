import * as React from 'react';

import { Input } from '@/components/ui/input';

/**
 * Input hardened against Chrome silently dumping the user's saved login
 * password or contact email into a stray text field. Observed in prod: a
 * Whisper STT key persisted as `admin123` (saved login password) and a voice
 * key persisted as `admin@test.com` (contact email) — both written straight to
 * the DB by the settings auto-save.
 *
 * Chrome has two independent autofill paths and they need different defenses:
 *  1. Password-manager autofill (saved logins) targets password fields and
 *     ignores `autoComplete="off"`. Defeated by `type="text"` plus the
 *     1Password / LastPass / Bitwarden ignore hints.
 *  2. Native profile autofill (email / address / phone) ALSO ignores
 *     `autoComplete="off"` and the hints; it only skips fields that are
 *     `readOnly` at the moment Chrome scans the page. So the input starts
 *     read-only and drops it on the first focus — by then the autofill pass is
 *     over, and a real click makes the field editable as normal.
 *
 * Use this for any free-text field that holds a secret or a short value and
 * has no business being autofilled (API keys, domain focus, etc.).
 */
export const NoAutofillInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<'input'>
>(({ onFocus, ...props }, ref) => {
  const [readOnly, setReadOnly] = React.useState(true);
  return (
    <Input
      ref={ref}
      {...props}
      type='text'
      readOnly={readOnly}
      onFocus={(e) => {
        setReadOnly(false);
        onFocus?.(e);
      }}
      autoComplete='off'
      data-1p-ignore='true'
      data-lpignore='true'
      data-bwignore=''
      data-form-type='other'
      spellCheck={false}
    />
  );
});
NoAutofillInput.displayName = 'NoAutofillInput';
