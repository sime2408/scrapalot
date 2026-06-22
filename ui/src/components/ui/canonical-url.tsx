import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const SITE_ORIGIN = 'https://scrapalot.app';

/**
 * Keeps <link rel="canonical"> and <meta property="og:url"> in sync with the
 * current route so each public page self-canonicalizes instead of all routes
 * inheriting the static root values from index.html (which would mark sub-pages
 * as duplicates of /).
 *
 * `/home` collapses to the canonical root `/` — both render the same HomePage.
 */
const CanonicalUrl: React.FC = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    const canonicalPath = pathname === '/home' ? '/' : pathname.replace(/\/+$/, '');
    const href = `${SITE_ORIGIN}${canonicalPath === '' ? '/' : canonicalPath}`;

    let link = document.querySelector<HTMLLinkElement>('link#canonical-link');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      link.id = 'canonical-link';
      document.head.appendChild(link);
    }
    link.href = href;

    let ogUrl = document.querySelector<HTMLMetaElement>('meta#og-url');
    if (!ogUrl) {
      ogUrl = document.createElement('meta');
      ogUrl.setAttribute('property', 'og:url');
      ogUrl.id = 'og-url';
      document.head.appendChild(ogUrl);
    }
    ogUrl.content = href;
  }, [pathname]);

  return null;
};

export default CanonicalUrl;
