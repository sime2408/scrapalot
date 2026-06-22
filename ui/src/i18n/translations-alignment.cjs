const fs = require("fs");
const path = require("path");
const glob = require("glob");
const os = require("os");

// Base path for locales and source code
const localesPath = path.join(__dirname, "locales");
const srcPath = path.join(path.resolve(__dirname, "../.."));

// Read the English file as the reference/canonical version
const enTranslationPath = path.join(localesPath, "en", "translation.json");
let enTranslation = JSON.parse(fs.readFileSync(enTranslationPath, "utf8"));

// Helper function to flatten nested objects with dot notation
function flattenObject(obj, prefix = "") {
  return Object.keys(obj).reduce((acc, k) => {
    const pre = prefix.length ? `${prefix}.` : "";
    if (typeof obj[k] === "object" && obj[k] !== null) {
      Object.assign(acc, flattenObject(obj[k], `${pre}${k}`));
    } else {
      acc[`${pre}${k}`] = obj[k];
    }
    return acc;
  }, {});
}

// Helper function to unflatten dot notation back to nested objects
function unflattenObject(obj) {
  const result = {};
  for (const key in obj) {
    if (!key || typeof key !== "string") {
      // console.warn(`Skipping invalid key during unflatten: ${key}`);
      continue;
    }
    const parts = key.split(".");
    let current = result;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) {
        // console.warn(`Skipping invalid path segment in key during unflatten: ${key}`);
        continue;
      }
      if (i === parts.length - 1) {
        current[part] = obj[key];
      } else {
        current[part] = current[part] || {};
        current = current[part];
      }
    }
  }
  return result;
}

// Function to find all translation keys used in the codebase
function findUsedTranslationKeys() {
  const keys = new Set();
  try {
    const patterns = [
      /(?:^|\W)t\s*\(\s*(['"])([a-zA-Z0-9._-]+)\1\s*[,)]/g,
      /i18next\.t\s*\(\s*(['"])([a-zA-Z0-9._-]+)\1\s*[,)]/g,
      /t\s*\(\s*(['"])([a-zA-Z0-9._-]+)\1\s*,/g,
      /t\s*\(\s*['"]([a-zA-Z0-9._-]+)['"]\s*,\s*\{\s*defaultValue:/g,
      /i18n\.t\s*\(\s*(['"])([a-zA-Z0-9._-]+)\1\s*[,)]/g,
      /(?:^|[^a-zA-Z0-9_])t\s*\(\s*(['"])([a-zA-Z0-9._-]+)\1\s*[,)]/g,
    ];
    const falsePosPatterns = [
      /^[a-z]+$/,
      /^[A-Z][a-zA-Z]+$/,
      /^content-/,
      /^[0-9]+$/,
      /^(Object|Array|Function|Promise|Boolean|Symbol|Error|Date)$/,
      /^(MOUNT|UNMOUNT|ANIMATION_END|HIDE|SCROLL|SCROLL_END)$/,
      /^(Authorization|GET|POST|PUT|DELETE)$/,
    ];
    const validKeyPattern =
      /^[a-zA-Z0-9]+((\.[a-zA-Z0-9]+)+|(\.[a-zA-Z0-9]+)*)?$/;
    const validPrefixes = [
      "common",
      "auth",
      "error",
      "form",
      "user",
      "settings",
      "navigation",
      "chat",
      "document",
      "search",
      "notification",
      "admin",
      "dashboard",
      "modal",
      "button",
      "label",
      "message",
      "validation",
      "general",
      "home",
    ];
    const allFiles = () => {
      return [
        ...glob.sync(`${srcPath}/**/*.ts`, {
          ignore: ["**/node_modules/**", "**/build/**", "**/dist/**"],
        }),
        ...glob.sync(`${srcPath}/**/*.tsx`, {
          ignore: ["**/node_modules/**", "**/build/**", "**/dist/**"],
        }),
        ...glob.sync(`${srcPath}/**/*.js`, {
          ignore: ["**/node_modules/**", "**/build/**", "**/dist/**"],
        }),
        ...glob.sync(`${srcPath}/**/*.jsx`, {
          ignore: ["**/node_modules/**", "**/build/**", "**/dist/**"],
        }),
      ];
    };
    const jsFiles = allFiles();
    jsFiles.forEach((file) => {
      const content = fs.readFileSync(file, "utf8");
      for (const pattern of patterns) {
        const matches = content.matchAll(pattern);
        for (const match of matches) {
          const key = match[2] || match[1];
          if (key && typeof key === "string") {
            const isFalsePositive = falsePosPatterns.some((p) => p.test(key));
            const isValidKey =
              validKeyPattern.test(key) ||
              validPrefixes.some(
                (prefix) => key === prefix || key.startsWith(`${prefix}.`)
              );
            if (!isFalsePositive && isValidKey) {
              keys.add(key);
            }
          }
        }
      }
    });
    return keys;
  } catch (error) {
    console.error("Error finding used translation keys:", error);
    return new Set();
  }
}

// Function to find keys that are in use but missing from the translation object
function findMissingKeysInTranslation(usedKeys, translationObj) {
  const missingKeys = new Set();
  const flattenedTranslation = flattenObject(translationObj);
  for (const key of usedKeys) {
    if (
      key &&
      typeof key === "string" &&
      key.trim() !== "" &&
      !flattenedTranslation.hasOwnProperty(key)
    ) {
      missingKeys.add(key);
    }
  }
  return missingKeys;
}

// Function to add missing keys to a translation object, using English value as placeholder
function addMissingKeysWithPlaceholders(
  targetLang,
  targetTranslationObj,
  missingKeys,
  englishMasterFlat
) {
  const flattenedTarget = flattenObject(targetTranslationObj);
  let count = 0;

  for (const key of missingKeys) {
    if (
      key &&
      typeof key === "string" &&
      key.trim() !== "" &&
      !flattenedTarget.hasOwnProperty(key)
    ) {
      flattenedTarget[key] = englishMasterFlat[key] || `[${key.split(".").pop()}]`; // Use English value or key part

      count++;
    }
  }
  if (count === 0) {
    console.log(`No missing keys to add for ${targetLang}`);
  } else {
    console.log(`Added ${count} missing keys to ${targetLang}`);
  }
  return unflattenObject(flattenedTarget);
}

// Function to remove keys that are not in the primary set from a translation object
function removeUnusedKeysFromTranslation(
  targetLang,
  targetTranslationObj,
  englishMasterKeysSet
) {
  const flattenedTarget = flattenObject(targetTranslationObj);
  const removedKeysForLang = [];
  for (const key in flattenedTarget) {
    if (!englishMasterKeysSet.has(key)) {
      removedKeysForLang.push(key);
      delete flattenedTarget[key];
    }
  }
  if (removedKeysForLang.length > 0) {
    console.log(`🗑️  Removed ${removedKeysForLang.length} unused keys from ${targetLang}:`);
    removedKeysForLang
      .slice(0, 20)
      .forEach((k) => console.log(`   - ${k}`));
    if (removedKeysForLang.length > 20)
      console.log(`   ... and ${removedKeysForLang.length - 20} more`);
  } else {
    console.log(`No unused keys to remove from ${targetLang}`);
  }
  return unflattenObject(flattenedTarget);
}

// Function to reorder keys in a translation object based on a master order
function reorderKeys(targetTranslationObj, masterKeyOrderFlat) {
  const reorderedFlat = {};
  const sourceFlat = flattenObject(targetTranslationObj);
  // Add keys in master order
  for (const key of masterKeyOrderFlat) {
    if (sourceFlat.hasOwnProperty(key)) {
      reorderedFlat[key] = sourceFlat[key];
    }
    // If a key from master is missing in target, it should have been added by addMissingKeysWithPlaceholders
    // or it means the master (English) has a key not relevant/added to other langs yet.
  }
  // Add any keys from target that might not be in master (should ideally not happen if master is canonical)
  for (const key in sourceFlat) {
    if (!reorderedFlat.hasOwnProperty(key)) {
      // This case implies the key exists in the target language file but not in the English master.
      // Depending on policy, these could be kept or removed. Current logic in removeUnusedKeysFromTranslation removes them.
      // For reordering, we only care about keys present in sourceFlat that should follow masterOrder.
      // If removeUnusedKeysFromTranslation ran, sourceFlat should only contain keys also in masterKeyOrderFlat.
      reorderedFlat[key] = sourceFlat[key];
    }
  }
  return unflattenObject(reorderedFlat);
}

// Function to find all files in all locales directories
function getAllLocaleFiles() {
  const locales = fs.readdirSync(localesPath);
  const localeFiles = {};

  locales.forEach((locale) => {
    const localePath = path.join(localesPath, locale);
    if (fs.statSync(localePath).isDirectory()) {
      const translationPath = path.join(localePath, "translation.json");
      if (fs.existsSync(translationPath)) {
        localeFiles[locale] = translationPath;
      }
    }
  });

  return localeFiles;
}

// Main function to process translations
function processTranslations(addMissing = false, removeUnused = false) {
  try {
    console.log("🔍 Scanning codebase for translation keys...");
    const usedCodeKeys = findUsedTranslationKeys();
    console.log(`📊 Found ${usedCodeKeys.size} unique translation keys in code`);

    // --- Step 1: Process English (en) as the master/canonical file ---
    console.log("\n📝 Processing English (master) file...");
    let englishFlat = flattenObject(enTranslation);
    const initialEnglishKeyCount = Object.keys(englishFlat).length;
    console.log(`   📊 English currently has ${initialEnglishKeyCount} keys`);

    if (addMissing && usedCodeKeys.size > 0) {
      const missingFromEnglish = findMissingKeysInTranslation(
        usedCodeKeys,
        enTranslation
      );
      if (missingFromEnglish.size > 0) {
          console.log(`🔍 Found ${missingFromEnglish.size} missing keys in English:`);
        Array.from(missingFromEnglish)
          .slice(0, 20)
          .forEach((k) => console.log(`   - ${k}`));
        if (missingFromEnglish.size > 20)
            console.log(`   ... and ${missingFromEnglish.size - 20} more`);

          enTranslation = addMissingKeysWithPlaceholders(
            "en",
            enTranslation,
            missingFromEnglish,
            englishFlat
          ); // Pass current englishFlat for placeholders
        englishFlat = flattenObject(enTranslation); // Re-flatten after adding
      } else {
        console.log("No missing keys found in English");
      }
    }

    if (removeUnused && usedCodeKeys.size > 0) {
      const englishKeysBeforeRemoval = Object.keys(englishFlat);
      const tempEnTranslationForRemoval = unflattenObject(englishFlat); // Use a temporary object for removal analysis
      const cleanedEnTranslationObject = removeUnusedKeysFromTranslation(
        "en",
        tempEnTranslationForRemoval,
        usedCodeKeys
      );
      const cleanedEnglishFlat = flattenObject(cleanedEnTranslationObject);
      const removedCountFromEnglish = englishKeysBeforeRemoval.filter(
        (k) => !cleanedEnglishFlat.hasOwnProperty(k)
      ).length;

      if (removedCountFromEnglish > 0) {
        // Logging of removed keys is handled inside removeUnusedKeysFromTranslation
        enTranslation = cleanedEnTranslationObject;
        englishFlat = cleanedEnglishFlat;
      } else {
        console.log("No unused keys found in English");
      }
    }

    // Save the potentially modified English file
    console.log("💾 Saving English translation file...");
    fs.writeFileSync(
      enTranslationPath,
      JSON.stringify(enTranslation, null, 2) + os.EOL
    );

    const masterKeyOrder = Object.keys(englishFlat); // This is the canonical order based on processed English
    const masterKeySet = new Set(masterKeyOrder);
    console.log(`📋 English now has ${masterKeyOrder.length} keys`);

    // --- Step 2: Process other language files ---
    console.log("\n🌍 Processing other language files...");
    const localeFiles = getAllLocaleFiles();
    for (const lang in localeFiles) {
      if (lang === "en") continue; // Skip English, already processed

      console.log(`\n🔄 Processing ${lang}...`);
      const langFilePath = localeFiles[lang];
      let langTranslation = JSON.parse(fs.readFileSync(langFilePath, "utf8"));
      let langFlat = flattenObject(langTranslation);
      const initialLangKeyCount = Object.keys(langFlat).length;
      console.log(`   📊 ${lang} currently has ${initialLangKeyCount} keys`);

      // Add missing keys (present in master English, missing in lang)
      if (addMissing) {
        const missingKeysForLang = new Set();
        for (const masterKey of masterKeyOrder) {
          if (!langFlat.hasOwnProperty(masterKey)) {
            missingKeysForLang.add(masterKey);
          }
        }
        if (missingKeysForLang.size > 0) {
          langTranslation = addMissingKeysWithPlaceholders(
            lang,
            langTranslation,
            missingKeysForLang,
            englishFlat
          );
          langFlat = flattenObject(langTranslation); // re-flatten
        }
      }

      // Remove unused keys (present in lang, not in master English)
      if (removeUnused) {
        langTranslation = removeUnusedKeysFromTranslation(
          lang,
          langTranslation,
          masterKeySet
        );
        langFlat = flattenObject(langTranslation); // re-flatten
      }

      // Reorder keys based on English master order and save
      const finalOrderedLangTranslation = reorderKeys(
        langTranslation,
        masterKeyOrder
      );
      console.log(`💾 Saving ${lang} translation file...`);
      fs.writeFileSync(
        langFilePath,
        JSON.stringify(finalOrderedLangTranslation, null, 2) + os.EOL
      );

      const finalKeyCount = Object.keys(flattenObject(finalOrderedLangTranslation)).length;
      console.log(`   ${lang} now has ${finalKeyCount} keys`);
    }

    console.log("\n🎉 Translation processing completed!");
  } catch (error) {
    console.error("❌ Error during translation processing:", error);
  }
}

// Parse command-line arguments
const args = process.argv.slice(2);
const showHelp = args.includes("--help") || args.includes("-h");
const addMissing = args.includes("--add-missing");
const removeUnused = args.includes("--remove-unused");
// const translateMissing = args.includes("--translate-missing"); // Placeholder for future

if (showHelp) {
  console.log(`
📝 Translation Alignment Script

Usage: node translations-alignment.cjs [options]

Options:
  --add-missing     Add missing translation keys found in code
  --remove-unused   Remove unused translation keys not found in code
  --help, -h        Show this help message

Examples:
  node translations-alignment.cjs --add-missing
  node translations-alignment.cjs --remove-unused
  node translations-alignment.cjs --add-missing --remove-unused
  `);
  process.exit(0);
}

if (!addMissing && !removeUnused) {
  console.log("❌ Please specify at least one option: --add-missing or --remove-unused");
  console.log("Use --help for more information");
  process.exit(1);
}

// Run the main function with the provided options
console.log("🚀 Starting translation alignment...");
processTranslations(addMissing, removeUnused);
