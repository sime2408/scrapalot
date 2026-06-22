/**
 * Shared TTS floating controls overlay used by both PDF and EPUB viewers.
 *
 * Call createTtsOverlay() once per viewer mount (inside useEffect), assign the
 * result to (window as any).ttsOverlay, and call .remove() on cleanup.
 */

export interface TtsOverlayCallbacks {
  onPrev?: () => void;
  onStop?: () => void;
  onNext?: () => void;
  onSpeedDecrease?: () => void;
  onSpeedIncrease?: () => void;
}

export interface TtsOverlayConfig {
  /** CSS for the outermost container div (controls positioning/z-index). */
  containerStyle: string;
  prevLabel: string;
  nextLabel: string;
}

export interface TtsOverlay {
  container: HTMLDivElement | null;
  controlsElement: HTMLDivElement | null;
  callbacks: {
    onPrev: (() => void) | null;
    onStop: (() => void) | null;
    onNext: (() => void) | null;
    onSpeedDecrease: (() => void) | null;
    onSpeedIncrease: (() => void) | null;
  };
  currentSpeed: number;
  createButton(icon: string, title: string, onClick: () => void, isDark: boolean, isSmall?: boolean): HTMLButtonElement;
  show(isDark: boolean, parentElement?: HTMLElement | null): void;
  setCallbacks(callbacks: TtsOverlayCallbacks): void;
  updateSpeed(speed: number, isDark: boolean): void;
  hide(): void;
  remove(): void;
}

export function createTtsOverlay(config: TtsOverlayConfig): TtsOverlay {
  const { containerStyle, prevLabel, nextLabel } = config;

  return {
    container: null,
    controlsElement: null,
    callbacks: {
      onPrev: null,
      onStop: null,
      onNext: null,
      onSpeedDecrease: null,
      onSpeedIncrease: null,
    },
    currentSpeed: 1.0,

    createButton(icon, title, onClick, isDark, isSmall = false) {
      const btn = document.createElement('button');
      btn.innerHTML = icon;
      btn.title = title;
      const size = isSmall ? '28px' : '36px';
      btn.style.cssText = `
        width: ${size};
        height: ${size};
        border: none;
        border-radius: 50%;
        cursor: pointer !important;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        background: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)'};
        color: ${isDark ? '#f1f1f1' : '#333333'};
        pointer-events: auto !important;
        font-size: ${isSmall ? '11px' : '14px'};
        position: relative;
        z-index: 2;
      `;
      btn.onmouseenter = () => {
        btn.style.background = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)';
        btn.style.transform = 'scale(1.1)';
      };
      btn.onmouseleave = () => {
        btn.style.background = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
        btn.style.transform = 'scale(1)';
      };
      btn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      };
      return btn;
    },

    show(isDark, parentElement) {
      const parent = parentElement ?? document.body;

      if (this.container && this.container.parentNode !== parent) {
        this.container.parentNode?.removeChild(this.container);
        this.container = null;
        this.controlsElement = null;
      }

      if (!this.container) {
        this.container = document.createElement('div');
        this.container.style.cssText = containerStyle;

        this.controlsElement = document.createElement('div');
        this.controlsElement.style.cssText = `
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          border-radius: 24px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          pointer-events: auto !important;
          position: relative;
          z-index: 1;
        `;

        this.container.appendChild(this.controlsElement);
        parent.appendChild(this.container);
      } else {
        parent.appendChild(this.container);
      }

      const bgColor = isDark ? 'rgba(0, 0, 0, 0.85)' : 'rgba(245, 245, 245, 0.95)';
      const textColor = isDark ? '#f1f1f1' : '#333333';
      const borderColor = isDark ? 'rgba(51, 51, 51, 0.5)' : 'rgba(224, 224, 224, 0.5)';

      if (this.controlsElement) {
        this.controlsElement.style.backgroundColor = bgColor;
        this.controlsElement.style.border = `1px solid ${borderColor}`;
        this.controlsElement.innerHTML = '';

        const prevBtn = this.createButton(
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>',
          prevLabel,
          () => this.callbacks.onPrev?.(),
          isDark,
        );
        const stopBtn = this.createButton(
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>',
          'Stop',
          () => this.callbacks.onStop?.(),
          isDark,
        );
        const nextBtn = this.createButton(
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>',
          nextLabel,
          () => this.callbacks.onNext?.(),
          isDark,
        );

        const separator = document.createElement('div');
        separator.style.cssText = `
          width: 1px;
          height: 24px;
          background: ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)'};
          margin: 0 4px;
        `;

        const speedDecreaseBtn = this.createButton(
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
          'Decrease speed',
          () => this.callbacks.onSpeedDecrease?.(),
          isDark,
          true,
        );

        const speedDisplay = document.createElement('div');
        speedDisplay.className = 'speed-display';
        speedDisplay.textContent = `${this.currentSpeed.toFixed(1)}x`;
        speedDisplay.style.cssText = `
          font-size: 12px;
          font-weight: 600;
          min-width: 32px;
          text-align: center;
          color: ${textColor};
          user-select: none;
        `;

        const speedIncreaseBtn = this.createButton(
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
          'Increase speed',
          () => this.callbacks.onSpeedIncrease?.(),
          isDark,
          true,
        );

        this.controlsElement.appendChild(prevBtn);
        this.controlsElement.appendChild(stopBtn);
        this.controlsElement.appendChild(nextBtn);
        this.controlsElement.appendChild(separator);
        this.controlsElement.appendChild(speedDecreaseBtn);
        this.controlsElement.appendChild(speedDisplay);
        this.controlsElement.appendChild(speedIncreaseBtn);
      }

      if (this.container) {
        this.container.style.opacity = '1';
      }
    },

    setCallbacks(callbacks) {
      this.callbacks.onPrev = callbacks.onPrev ?? null;
      this.callbacks.onStop = callbacks.onStop ?? null;
      this.callbacks.onNext = callbacks.onNext ?? null;
      this.callbacks.onSpeedDecrease = callbacks.onSpeedDecrease ?? null;
      this.callbacks.onSpeedIncrease = callbacks.onSpeedIncrease ?? null;
    },

    updateSpeed(speed) {
      this.currentSpeed = speed;
      const speedDisplay = this.controlsElement?.querySelector('.speed-display');
      if (speedDisplay) {
        speedDisplay.textContent = `${speed.toFixed(1)}x`;
      }
    },

    hide() {
      if (this.container) {
        this.container.style.opacity = '0';
      }
    },

    remove() {
      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
        this.container = null;
        this.controlsElement = null;
      }
    },
  };
}
