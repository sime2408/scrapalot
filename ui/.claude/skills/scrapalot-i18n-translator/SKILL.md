---
name: scrapalot-i18n-translator
description: Use this skill when adding or updating translations for Scrapalot UI. This includes adding new translation keys, translating UI text to multiple languages (English, Croatian, etc.), maintaining translation consistency, and ensuring all language files are kept in sync.
---

# i18n Translator (Scrapalot UI)

## Overview

Manage internationalization (i18n) for Scrapalot UI using i18next and react-i18next. Ensure all UI text is properly translated across all supported languages with consistent terminology and proper context.

## Supported Languages

- **English (en)** - Primary language
- **Croatian (hr)** - Secondary language
- **Add more as needed**

## Translation File Structure

```
src/i18n/
├── locales/
│   ├── en/
│   │   └── translation.json
│   ├── hr/
│   │   └── translation.json
│   └── [other-languages]/
│       └── translation.json
└── index.ts
```

## Task 1: Adding New Translation Keys

### Workflow

1. **Identify the text** that needs translation
2. **Choose appropriate namespace** (common, settings, chat, etc.)
3. **Add key to ALL language files** (CRITICAL!)
4. **Use semantic key names** (action-based, not literal text)

### Example: Adding a New Feature

**Step 1: Add to English** (`src/i18n/locales/en/translation.json`):

```json
{
  "workspace": {
    "title": "Workspaces",
    "createNew": "Create New Workspace",
    "deleteConfirm": "Are you sure you want to delete this workspace?",
    "members": {
      "title": "Team Members",
      "invite": "Invite Member",
      "role": {
        "owner": "Owner",
        "admin": "Administrator",
        "member": "Member"
      }
    }
  }
}
```

**Step 2: Add to Croatian** (`src/i18n/locales/hr/translation.json`):

```json
{
  "workspace": {
    "title": "Radni prostori",
    "createNew": "Stvori novi radni prostor",
    "deleteConfirm": "Jeste li sigurni da želite izbrisati ovaj radni prostor?",
    "members": {
      "title": "Članovi tima",
      "invite": "Pozovi člana",
      "role": {
        "owner": "Vlasnik",
        "admin": "Administrator",
        "member": "Član"
      }
    }
  }
}
```

**Step 3: Use in Component**:

```tsx
import { useTranslation } from 'react-i18next'

function WorkspaceHeader() {
  const { t } = useTranslation()

  return (
    <div>
      <h1>{t('workspace.title')}</h1>
      <Button>{t('workspace.createNew')}</Button>
    </div>
  )
}
```

## Task 2: Translation Key Naming Conventions

### Semantic, Not Literal

```json
// ❌ BAD - Literal text as key
{
  "clickHere": "Click here",
  "theUserHasBeenDeleted": "The user has been deleted"
}

// GOOD - Semantic, action-based keys
{
  "common": {
    "action": "Click here",
    "confirm": "Confirm"
  },
  "user": {
    "deleteSuccess": "User has been deleted"
  }
}
```

### Organize by Feature/Domain

```json
{
  "common": {
    "save": "Save",
    "cancel": "Cancel",
    "delete": "Delete",
    "edit": "Edit",
    "loading": "Loading...",
    "error": "Error",
    "success": "Success"
  },
  "auth": {
    "login": "Log in",
    "logout": "Log out",
    "register": "Register",
    "forgotPassword": "Forgot password?"
  },
  "chat": {
    "newSession": "New chat",
    "sendMessage": "Send message",
    "typing": "Typing...",
    "error": {
      "failedToSend": "Failed to send message",
      "connectionLost": "Connection lost"
    }
  },
  "settings": {
    "title": "Settings",
    "appearance": "Appearance",
    "language": "Language",
    "theme": {
      "light": "Light",
      "dark": "Dark",
      "system": "System"
    }
  }
}
```

## Task 3: Interpolation and Pluralization

### Variable Interpolation

```json
// English
{
  "greeting": "Hello, {{name}}!",
  "documentsSelected": "{{count}} document(s) selected"
}

// Croatian
{
  "greeting": "Pozdrav, {{name}}!",
  "documentsSelected": "{{count}} dokument(a) odabrano"
}
```

```tsx
function Greeting({ username }: { username: string }) {
  const { t } = useTranslation()

  return <h1>{t('greeting', { name: username })}</h1>
}
```

### Pluralization

```json
// English
{
  "itemCount": "{{count}} item",
  "itemCount_plural": "{{count}} items"
}

// Croatian (more complex plural rules)
{
  "itemCount_one": "{{count}} stavka",
  "itemCount_few": "{{count}} stavke",
  "itemCount_many": "{{count}} stavki"
}
```

```tsx
function ItemCounter({ count }: { count: number }) {
  const { t } = useTranslation()

  return <span>{t('itemCount', { count })}</span>
}
```

## Task 4: Maintaining Translation Consistency

### Common Terms Dictionary

Maintain consistent translations for common terms:

| English | Croatian | Context |
|---------|----------|---------|
| Collection | Zbirka | Document collection |
| Document | Dokument | File/document |
| Workspace | Radni prostor | Team workspace |
| Session | Sesija | Chat session |
| Message | Poruka | Chat message |
| Settings | Postavke | App settings |
| Provider | Pružatelj | AI provider |
| Model | Model | AI model |
| Search | Pretraživanje | Search action |
| Filter | Filtriraj | Filter action |

### Check for Missing Keys

```bash
# Find keys in English that are missing in Croatian
diff <(jq -r 'keys[]' src/i18n/locales/en/translation.json | sort) \
     <(jq -r 'keys[]' src/i18n/locales/hr/translation.json | sort)
```

## Task 5: Context-Aware Translations

### Same Word, Different Context

```json
{
  "common": {
    "close": "Close"  // Close button
  },
  "proximity": {
    "close": "Near"   // Close distance
  },
  "auth": {
    "close": "End session"  // Close account
  }
}
```

### Provide Context in Keys

```json
{
  "button": {
    "save": "Save",
    "saveChanges": "Save Changes",
    "saveAndContinue": "Save & Continue"
  }
}
```

## Task 6: Form Validations

```json
{
  "validation": {
    "required": "This field is required",
    "email": {
      "invalid": "Please enter a valid email address",
      "required": "Email is required"
    },
    "password": {
      "minLength": "Password must be at least {{min}} characters",
      "match": "Passwords must match",
      "weak": "Password is too weak"
    },
    "name": {
      "minLength": "Name must be at least {{min}} characters",
      "maxLength": "Name cannot exceed {{max}} characters"
    }
  }
}
```

Croatian:

```json
{
  "validation": {
    "required": "Ovo polje je obavezno",
    "email": {
      "invalid": "Molimo unesite valjanu email adresu",
      "required": "Email je obavezan"
    },
    "password": {
      "minLength": "Lozinka mora imati najmanje {{min}} znakova",
      "match": "Lozinke se moraju podudarati",
      "weak": "Lozinka je preslaba"
    },
    "name": {
      "minLength": "Ime mora imati najmanje {{min}} znakova",
      "maxLength": "Ime ne može prelaziti {{max}} znakova"
    }
  }
}
```

## Task 7: Date and Time Formatting

Use `date-fns` for locale-aware formatting:

```tsx
import { format } from 'date-fns'
import { enUS, hr } from 'date-fns/locale'
import { useTranslation } from 'react-i18next'

function FormattedDate({ date }: { date: Date }) {
  const { i18n } = useTranslation()

  const locale = i18n.language === 'hr' ? hr : enUS

  return <span>{format(date, 'PPP', { locale })}</span>
}
```

## Best Practices

### 1. Always Update All Languages

```bash
# CRITICAL: When adding keys, update ALL language files
# DO THIS
# 1. Add to en/translation.json
# 2. Add to hr/translation.json
# 3. Add to any other language files

# ❌ NEVER DO THIS
# Only updating English and forgetting Croatian
```

### 2. Use Nested Objects for Organization

```json
{
  "settings": {
    "profile": {
      "title": "Profile Settings",
      "name": "Display Name",
      "email": "Email Address"
    },
    "privacy": {
      "title": "Privacy Settings",
      "visibility": "Profile Visibility"
    }
  }
}
```

### 3. Avoid Hardcoded Text

```tsx
// ❌ BAD
<Button>Save Changes</Button>

// GOOD
<Button>{t('common.saveChanges')}</Button>
```

### 4. Use Translation Keys in Error Messages

```tsx
// ❌ BAD
throw new Error("Failed to save document")

// GOOD
import { i18n } from '@/i18n'

throw new Error(i18n.t('errors.document.saveFailed'))
```

## Common Patterns

### Loading States

```json
{
  "loading": {
    "default": "Loading...",
    "documents": "Loading documents...",
    "profile": "Loading profile...",
    "saving": "Saving changes..."
  }
}
```

### Success/Error Messages

```json
{
  "messages": {
    "success": {
      "saved": "Changes saved successfully",
      "deleted": "Item deleted successfully",
      "created": "Item created successfully"
    },
    "error": {
      "saveFailed": "Failed to save changes",
      "deleteFailed": "Failed to delete item",
      "networkError": "Network error. Please try again."
    }
  }
}
```

### Confirmation Dialogs

```json
{
  "confirm": {
    "delete": {
      "title": "Delete {{item}}?",
      "description": "This action cannot be undone.",
      "action": "Delete"
    },
    "discard": {
      "title": "Discard changes?",
      "description": "You have unsaved changes that will be lost.",
      "action": "Discard"
    }
  }
}
```

## Translation Checklist

Before submitting changes:

- [ ] All new keys added to **every** language file
- [ ] Keys use semantic naming (not literal text)
- [ ] Keys are properly nested by feature/domain
- [ ] Interpolation variables use consistent naming
- [ ] Pluralization rules added where needed
- [ ] No hardcoded text remains in components
- [ ] Common terms use consistent translations
- [ ] Tested in all supported languages

## Tools

### Check for Missing Keys Script

```bash
#!/bin/bash
# compare_translations.sh

EN_KEYS=$(jq -r 'paths(scalars) | join(".")' src/i18n/locales/en/translation.json | sort)
HR_KEYS=$(jq -r 'paths(scalars) | join(".")' src/i18n/locales/hr/translation.json | sort)

echo "Keys in EN but not in HR:"
comm -23 <(echo "$EN_KEYS") <(echo "$HR_KEYS")

echo "\nKeys in HR but not in EN:"
comm -13 <(echo "$EN_KEYS") <(echo "$HR_KEYS")
```

## Reference

- **i18next Docs**: https://www.i18next.com/
- **react-i18next**: https://react.i18next.com/
- **Translation Files**: `src/i18n/locales/`
