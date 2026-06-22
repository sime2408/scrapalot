import * as React from 'react';
import { profilePicSources } from '@/lib/profile-picture';

interface ProfileImgProps
  extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** Stored picture reference (filename, data/upload path, or absolute URL). */
  pic: string | null | undefined;
  /** Cache-buster appended after a fresh upload to force a reload. */
  cacheBuster?: number;
}

/**
 * Plain `<img>` that loads a profile picture local-first and transparently
 * falls back to the production host when the local file is missing (404).
 * In production both URLs are identical, so the fallback never triggers.
 *
 * Use this for non-Radix avatar render sites; Radix `Avatar` usages get the
 * same behaviour via `AvatarImage`'s `fallbackSrc` prop.
 */
export const ProfileImg = React.forwardRef<HTMLImageElement, ProfileImgProps>(
  ({ pic, cacheBuster, onError, ...imgProps }, ref) => {
    const { src, fallbackSrc } = profilePicSources(pic, cacheBuster);
    const [active, setActive] = React.useState(src);
    // Reset to the primary src whenever it changes (e.g. cache-buster bump).
    React.useEffect(() => setActive(src), [src]);
    return (
      <img
        ref={ref}
        src={active}
        onError={(e) => {
          if (fallbackSrc && active !== fallbackSrc) {
            setActive(fallbackSrc);
          }
          onError?.(e);
        }}
        {...imgProps}
      />
    );
  },
);
ProfileImg.displayName = 'ProfileImg';
