window.onload = function() {
  //<editor-fold desc="Changeable Configuration Block">

  // the following lines will be replaced by docker/configurator, when it runs in a docker-container
  window.ui = SwaggerUIBundle({
    urls: [
      {name: "Backend API (Kotlin)", url: "/api-docs/backend"},
      {name: "Chat API (Python - 177 endpoints)", url: "/api-docs/chat"},
      {name: "Gateway API", url: "/v3/api-docs"}
    ],
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [
      SwaggerUIBundle.presets.apis,
      SwaggerUIStandalonePreset
    ],
    plugins: [
      SwaggerUIBundle.plugins.DownloadUrl
    ],
    layout: "StandaloneLayout",
    operationsSorter: "alpha",
    tagsSorter: "alpha",
    displayRequestDuration: true,
    onComplete: function() {
      // Replace OpenAPI logo with Scrapalot logo
      const topbarWrapper = document.querySelector('.topbar .topbar-wrapper');
      if (topbarWrapper) {
        const link = topbarWrapper.querySelector('a');
        if (link) {
          link.innerHTML = '';
          const logo = document.createElement('img');
          logo.src = 'https://scrapalot.app/logo-black.svg';
          logo.alt = 'Scrapalot';
          logo.style.height = '40px';
          logo.style.width = 'auto';
          logo.style.maxWidth = '200px';
          link.appendChild(logo);
          link.href = 'https://scrapalot.app';
          link.target = '_blank';
        }
      }

      // Add custom title
      const infoTitle = document.querySelector('.info .title');
      if (infoTitle) {
        infoTitle.textContent = 'Scrapalot API Documentation';
      }
    }
  });

  //</editor-fold>
};
