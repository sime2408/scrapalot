import React, {
  createContext,
  useContext,
  useState,
  ReactNode,
} from 'react';
import { userPrefs } from '@/lib/storage-utils';

interface FontSettingsContextType {
  fontSize: number;
  setFontSize: (size: number) => void;
  codeTheme: string;
  setCodeTheme: (theme: string) => void;
}

const FontSettingsContext = createContext<FontSettingsContextType | undefined>(
  undefined
);

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export function useFontSettings() {
  const context = useContext(FontSettingsContext);
  if (context === undefined) {
    throw new Error(
      'useFontSettings must be used within a FontSettingsProvider'
    );
  }
  return context;
}

interface FontSettingsProviderProps {
  children: ReactNode;
}

export function FontSettingsProvider({ children }: FontSettingsProviderProps) {
  const [fontSize, setFontSizeState] = useState(() => {
    return userPrefs.getFontSize();
  });

  const [codeTheme, setCodeThemeState] = useState(() => {
    return userPrefs.getCodeTheme();
  });

  const setFontSize = (size: number) => {
    setFontSizeState(size);
    userPrefs.setFontSize(size);
  };

  const setCodeTheme = (theme: string) => {
    setCodeThemeState(theme);
    userPrefs.setCodeTheme(theme);
  };

  const value = {
    fontSize,
    setFontSize,
    codeTheme,
    setCodeTheme,
  };

  return (
    <FontSettingsContext.Provider value={value}>
      {children}
    </FontSettingsContext.Provider>
  );
}
