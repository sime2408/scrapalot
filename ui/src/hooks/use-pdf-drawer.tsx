import { useState, useEffect } from 'react';

/**
 * Custom hook to track if the PDF drawer is open by monitoring body classes
 */
export const usePdfDrawer = () => {
  const [isPdfOpen, setIsPdfOpen] = useState(false);

  useEffect(() => {
    const checkPdfStatus = () => {
      const isPdfDrawerOpen =
        document.body.classList.contains('pdf-drawer-open');
      setIsPdfOpen(isPdfDrawerOpen);
    };

    // Initial check
    checkPdfStatus();

    // Set up a mutation observer to detect changes to the body class list
    const observer = new MutationObserver(checkPdfStatus);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  return isPdfOpen;
};
