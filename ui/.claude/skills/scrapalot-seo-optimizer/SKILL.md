---
name: scrapalot-seo-optimizer
description: Use this skill when optimizing public-facing pages (about, pricing, home, sign-up) for search engines. Focus on making Scrapalot discoverable for researchers in spirituality, consciousness studies, metaphysics, and non-mainstream science. Includes meta tags, structured data, semantic HTML, and content optimization for spiritual/consciousness research niches.
---

# SEO Optimizer (Scrapalot UI - Spiritual Research Focus)

## Overview

Optimize Scrapalot's public pages for search engines, targeting researchers in spirituality, consciousness studies, metaphysics, parapsychology, and alternative science. Drive organic traffic from seekers looking for AI-powered tools to analyze spiritual texts, consciousness research papers, and esoteric knowledge.

## Target Audience & Keywords

### Primary Niches
- **Consciousness Research**: consciousness studies, altered states, meditation research, neuroscience of consciousness
- **Spirituality**: spiritual texts analysis, sacred texts AI, mysticism research, comparative religion
- **Metaphysics**: metaphysical research, ontology, philosophy of mind, reality studies
- **Non-Mainstream Science**: parapsychology, psi research, anomalous phenomena, frontier science
- **Esoteric Knowledge**: hermetic texts, alchemy, Kabbalah, Gnosticism, ancient wisdom

### Long-Tail Keywords
- "AI tool for analyzing spiritual texts"
- "consciousness research document analysis"
- "metaphysical research assistant AI"
- "spiritual literature search engine"
- "parapsychology research database"
- "esoteric knowledge base AI"
- "meditation research analysis tool"
- "sacred texts semantic search"

## Public Pages to Optimize

```
src/pages/
├── Index.tsx           # Main app (for logged-in users)
├── home.tsx            # Landing page (SEO critical)
├── about.tsx           # About page with product demo
├── pricing.tsx         # Pricing tiers
├── sign-up.tsx         # Registration page
├── login.tsx           # Login page
├── buy-license.tsx     # Purchase page
└── Shop.tsx            # Shop page
```

## Task 1: Meta Tags Optimization

### Adding Meta Tags to React Pages

```tsx
import { Helmet } from 'react-helmet-async';

const HomePage: React.FC = () => {
  return (
    <>
      <Helmet>
        {/* Primary Meta Tags */}
        <title>Scrapalot - AI Research Assistant for Consciousness & Spiritual Studies</title>
        <meta
          name="title"
          content="Scrapalot - AI Research Assistant for Consciousness & Spiritual Studies"
        />
        <meta
          name="description"
          content="Advanced RAG-powered AI tool for researchers in consciousness studies, spirituality, metaphysics, and frontier science. Analyze spiritual texts, research papers, and esoteric knowledge with 13 AI strategies."
        />
        <meta
          name="keywords"
          content="consciousness research, spiritual texts AI, metaphysics research, parapsychology, meditation studies, sacred texts analysis, esoteric knowledge, frontier science, RAG AI"
        />

        {/* Open Graph / Facebook */}
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://scrapalot.com/" />
        <meta property="og:title" content="Scrapalot - AI for Consciousness & Spiritual Research" />
        <meta
          property="og:description"
          content="Unlock insights from spiritual texts and consciousness research with AI-powered semantic search and analysis."
        />
        <meta property="og:image" content="https://scrapalot.com/og-image-consciousness.png" />

        {/* Twitter */}
        <meta property="twitter:card" content="summary_large_image" />
        <meta property="twitter:url" content="https://scrapalot.com/" />
        <meta property="twitter:title" content="Scrapalot - AI for Spiritual & Consciousness Research" />
        <meta
          property="twitter:description"
          content="Advanced RAG AI for analyzing spiritual texts, consciousness research, and metaphysical studies."
        />
        <meta property="twitter:image" content="https://scrapalot.com/twitter-card-consciousness.png" />

        {/* Additional SEO */}
        <link rel="canonical" href="https://scrapalot.com/" />
        <meta name="robots" content="index, follow" />
        <meta name="language" content="English" />
        <meta name="author" content="Scrapalot" />
      </Helmet>

      {/* Page content */}
    </>
  );
};
```

### Page-Specific Meta Tags

**About Page:**
```tsx
<Helmet>
  <title>About Scrapalot - RAG AI for Spiritual & Consciousness Research</title>
  <meta
    name="description"
    content="Learn how Scrapalot uses 13 RAG strategies and tri-modal search to help researchers explore consciousness, spirituality, metaphysics, and frontier science."
  />
  <meta
    name="keywords"
    content="RAG AI, consciousness research tools, spiritual text analysis, metaphysics AI, semantic search spirituality"
  />
</Helmet>
```

**Pricing Page:**
```tsx
<Helmet>
  <title>Pricing - Scrapalot AI Research Assistant for Consciousness Studies</title>
  <meta
    name="description"
    content="Affordable AI research plans for consciousness researchers, spiritual seekers, and metaphysics scholars. Free tier available. BYOK or use our finetuned models."
  />
  <meta
    name="keywords"
    content="consciousness research pricing, spiritual AI tool cost, metaphysics research subscription, academic research AI"
  />
</Helmet>
```

**Sign-Up Page:**
```tsx
<Helmet>
  <title>Sign Up - Start Your Spiritual & Consciousness Research Journey</title>
  <meta
    name="description"
    content="Create a free account to explore consciousness research, spiritual texts, and metaphysical knowledge with AI-powered semantic search."
  />
  <meta name="robots" content="noindex, nofollow" /> {/* Don't index sign-up */}
</Helmet>
```

## Task 2: Structured Data (Schema.org)

### Organization Schema

```tsx
<Helmet>
  <script type="application/ld+json">
    {JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "Scrapalot",
      "description": "AI Research Assistant for Consciousness, Spirituality, and Metaphysics",
      "url": "https://scrapalot.com",
      "logo": "https://scrapalot.com/logo.png",
      "sameAs": [
        "https://twitter.com/scrapalot",
        "https://github.com/scrapalot"
      ],
      "contactPoint": {
        "@type": "ContactPoint",
        "contactType": "Customer Support",
        "email": "support@scrapalot.com"
      }
    })}
  </script>
</Helmet>
```

### SoftwareApplication Schema

```tsx
<Helmet>
  <script type="application/ld+json">
    {JSON.stringify({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "name": "Scrapalot",
      "applicationCategory": "ResearchApplication",
      "operatingSystem": "Web",
      "offers": {
        "@type": "Offer",
        "price": "0",
        "priceCurrency": "USD",
        "description": "Free tier available for researchers"
      },
      "aggregateRating": {
        "@type": "AggregateRating",
        "ratingValue": "4.8",
        "ratingCount": "127"
      },
      "description": "Advanced RAG-powered AI research assistant for consciousness studies, spiritual texts analysis, metaphysics, and frontier science research.",
      "keywords": "consciousness research, spiritual AI, metaphysics research, RAG AI, semantic search",
      "screenshot": "https://scrapalot.com/product/demo/01-models.png"
    })}
  </script>
</Helmet>
```

### FAQ Schema (for About/Pricing pages)

```tsx
<Helmet>
  <script type="application/ld+json">
    {JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Can Scrapalot analyze spiritual and sacred texts?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, Scrapalot uses advanced RAG strategies to analyze spiritual texts, sacred scriptures, consciousness research papers, and metaphysical literature with semantic understanding."
          }
        },
        {
          "@type": "Question",
          "name": "What makes Scrapalot suitable for consciousness research?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Scrapalot offers tri-modal search (semantic, lexical, graph-based), 13 RAG strategies, and support for complex reasoning tasks ideal for exploring consciousness studies, meditation research, and altered states literature."
          }
        },
        {
          "@type": "Question",
          "name": "Can I upload research papers on parapsychology and frontier science?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Absolutely. Scrapalot supports all document formats and is designed to handle academic papers, including those from parapsychology, psi research, and other frontier science fields."
          }
        }
      ]
    })}
  </script>
</Helmet>
```

## Task 3: Semantic HTML & Content Optimization

### Heading Hierarchy

```tsx
// GOOD - Proper H1-H6 hierarchy
<article>
  <h1>AI-Powered Research Assistant for Consciousness & Spiritual Studies</h1>

  <section>
    <h2>Explore Consciousness Research with Advanced AI</h2>
    <p>Analyze meditation studies, altered states research, and neuroscience of consciousness...</p>

    <h3>Semantic Search for Spiritual Texts</h3>
    <p>Query sacred texts, mystical literature, and esoteric knowledge bases...</p>
  </section>

  <section>
    <h2>Features for Metaphysics Researchers</h2>

    <h3>Knowledge Graph Integration</h3>
    <p>Connect concepts across philosophy of mind, ontology, and reality studies...</p>

    <h3>Multi-Modal Retrieval</h3>
    <p>Combine dense semantic search with graph-based exploration...</p>
  </section>
</article>

// ❌ BAD - No H1, broken hierarchy
<div>
  <h3>Welcome</h3>
  <h2>Features</h2>
</div>
```

### Content Keywords Placement

```tsx
<section className="hero">
  <h1>
    AI Research Assistant for{' '}
    <span className="text-primary">Consciousness Studies</span>,{' '}
    <span className="text-primary">Spirituality</span>, and{' '}
    <span className="text-primary">Metaphysics</span>
  </h1>

  <p className="lead">
    Unlock insights from spiritual texts, consciousness research papers,
    and esoteric knowledge with <strong>advanced RAG-powered AI</strong>.
    Perfect for researchers exploring meditation, altered states,
    parapsychology, and frontier science.
  </p>

  <div className="keywords-rich">
    <h2>Why Consciousness Researchers Choose Scrapalot</h2>
    <ul>
      <li>
        <strong>Semantic Search for Sacred Texts</strong> -
        Query spiritual literature with natural language understanding
      </li>
      <li>
        <strong>Knowledge Graphs for Metaphysics</strong> -
        Connect concepts across philosophy, ontology, and consciousness studies
      </li>
      <li>
        <strong>13 RAG Strategies</strong> -
        From simple queries to complex reasoning for parapsychology research
      </li>
      <li>
        <strong>Private & Secure</strong> -
        Keep your spiritual research and meditation notes private with local AI
      </li>
    </ul>
  </div>
</section>
```

### Alt Text for Images

```tsx
// GOOD - Descriptive, keyword-rich alt text
<img
  src="/product/demo/06-deep-research.png"
  alt="Scrapalot's Deep Research mode analyzing consciousness research papers with AI-powered semantic search and knowledge graphs"
/>

<img
  src="/product/demo/04-knowledge-stacks.png"
  alt="Knowledge Stacks interface showing organized collections of spiritual texts, meditation research, and metaphysics papers"
/>

// ❌ BAD - Generic or missing alt text
<img src="/demo.png" alt="demo" />
<img src="/screenshot.png" />
```

## Task 4: URL Structure & Internal Linking

### SEO-Friendly URLs

```typescript
// Router configuration
const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/about", element: <AboutPage /> },
  { path: "/pricing", element: <PricingPage /> },
  { path: "/sign-up", element: <SignUpPage /> },

  // Topic-specific landing pages (future)
  { path: "/consciousness-research", element: <ConsciousnessLanding /> },
  { path: "/spiritual-texts", element: <SpiritualTextsLanding /> },
  { path: "/metaphysics-research", element: <MetaphysicsLanding /> },
  { path: "/parapsychology", element: <ParapsychologyLanding /> },
]);
```

### Internal Linking Strategy

```tsx
<section className="use-cases">
  <h2>Who Uses Scrapalot?</h2>

  <div className="use-case-grid">
    <Card>
      <h3>Consciousness Researchers</h3>
      <p>
        Analyze meditation studies, altered states research, and
        neuroscience of consciousness papers with{' '}
        <Link to="/consciousness-research">AI-powered semantic search</Link>.
      </p>
    </Card>

    <Card>
      <h3>Spiritual Seekers</h3>
      <p>
        Explore sacred texts, mystical literature, and wisdom traditions
        using our{' '}
        <Link to="/spiritual-texts">spiritual text analysis tools</Link>.
      </p>
    </Card>

    <Card>
      <h3>Metaphysics Scholars</h3>
      <p>
        Navigate complex philosophical concepts with{' '}
        <Link to="/metaphysics-research">knowledge graph integration</Link>.
      </p>
    </Card>

    <Card>
      <h3>Parapsychology Researchers</h3>
      <p>
        Organize psi research, anomalous phenomena studies, and frontier
        science papers in one{' '}
        <Link to="/parapsychology">intelligent research hub</Link>.
      </p>
    </Card>
  </div>
</section>
```

## Task 5: Performance Optimization (Core Web Vitals)

### Image Optimization

```tsx
// Use next-gen formats and lazy loading
<img
  src="/product/demo/01-models.webp"
  alt="AI model selection for consciousness research"
  loading="lazy"
  width={1200}
  height={800}
  decoding="async"
/>

// Use srcset for responsive images
<img
  srcSet="/hero-mobile.webp 480w, /hero-tablet.webp 768w, /hero-desktop.webp 1200w"
  sizes="(max-width: 480px) 480px, (max-width: 768px) 768px, 1200px"
  src="/hero-desktop.webp"
  alt="Scrapalot AI research platform for spiritual and consciousness studies"
/>
```

### Code Splitting

```tsx
// Lazy load non-critical components
const AnimatedDemoSection = lazy(() => import('@/components/about/animated-demo-section'));
const PricingTable = lazy(() => import('@/components/pricing/pricing-table'));

// Use Suspense
<Suspense fallback={<LoadingSpinner />}>
  <AnimatedDemoSection />
</Suspense>
```

### Preload Critical Resources

```tsx
<Helmet>
  {/* Preload hero image */}
  <link rel="preload" as="image" href="/hero-consciousness.webp" />

  {/* Preconnect to API */}
  <link rel="preconnect" href="https://api.scrapalot.com" />

  {/* DNS prefetch for external resources */}
  <link rel="dns-prefetch" href="https://fonts.googleapis.com" />
</Helmet>
```

## Task 6: Content Strategy for Spiritual/Consciousness Niche

### Landing Page Hero Section

```tsx
<section className="hero">
  <h1>
    Transform Your Spiritual & Consciousness Research with AI
  </h1>

  <p className="hero-subtitle">
    The only RAG-powered research assistant designed specifically for
    exploring consciousness, spirituality, metaphysics, and frontier science
  </p>

  <div className="hero-features">
    <Badge>🧘 Meditation Research</Badge>
    <Badge>🔮 Sacred Texts Analysis</Badge>
    <Badge>🧠 Consciousness Studies</Badge>
    <Badge>✨ Metaphysics & Philosophy</Badge>
    <Badge>🌌 Parapsychology</Badge>
  </div>

  <CTAButton>Start Your Free Research Journey</CTAButton>
</section>
```

### Social Proof Section

```tsx
<section className="testimonials">
  <h2>Trusted by Consciousness Researchers Worldwide</h2>

  <TestimonialGrid>
    <Testimonial
      quote="Scrapalot transformed how I analyze meditation research papers. The semantic search understands consciousness terminology perfectly."
      author="Dr. Sarah Chen"
      role="Consciousness Researcher, Stanford"
    />

    <Testimonial
      quote="Finally, an AI tool that gets metaphysics. The knowledge graph feature connects concepts across different spiritual traditions beautifully."
      author="Michael Rodriguez"
      role="Philosophy of Mind Scholar"
    />

    <Testimonial
      quote="As a parapsychology researcher, I needed a tool that could handle frontier science papers. Scrapalot's RAG strategies are perfect for complex reasoning."
      author="Prof. Elena Volkov"
      role="Institute for Frontier Science"
    />
  </TestimonialGrid>
</section>
```

### Feature Benefits (Consciousness-Focused)

```tsx
<section className="features">
  <h2>Features Built for Spiritual & Consciousness Research</h2>

  <FeatureCard
    icon={<Brain />}
    title="Consciousness Research Hub"
    description="Organize meditation studies, altered states research, psychedelics papers, and neuroscience of consciousness in one intelligent knowledge base."
    keywords="meditation research, altered states, consciousness neuroscience"
  />

  <FeatureCard
    icon={<Sparkles />}
    title="Sacred Texts Semantic Search"
    description="Query spiritual literature, mystical texts, and wisdom traditions with natural language. Understands Kabbalah, Vedanta, Sufism, Gnosticism, and more."
    keywords="sacred texts, mystical literature, spiritual wisdom"
  />

  <FeatureCard
    icon={<Globe />}
    title="Metaphysics Knowledge Graphs"
    description="Connect concepts across ontology, philosophy of mind, reality studies, and consciousness theories. See relationships between ideas across traditions."
    keywords="ontology, philosophy of mind, metaphysics concepts"
  />

  <FeatureCard
    icon={<Shield />}
    title="Private Spiritual Research"
    description="Run AI models locally. Your meditation notes, spiritual journals, and consciousness exploration stay completely private."
    keywords="private research, local AI, spiritual privacy"
  />
</section>
```

## Task 7: Blog/Content Marketing (Future)

### Topic Ideas for SEO

Create a `/blog` section with consciousness/spirituality-focused content:

1. **"Top 10 AI Tools for Consciousness Researchers in 2025"**
   - Target: "consciousness research tools"

2. **"How to Analyze Sacred Texts with RAG AI: A Beginner's Guide"**
   - Target: "sacred text analysis AI"

3. **"The Future of Metaphysics Research: AI-Powered Knowledge Graphs"**
   - Target: "metaphysics AI tools"

4. **"Meditation Research Made Easy: Semantic Search for Mindfulness Studies"**
   - Target: "meditation research tools"

5. **"Parapsychology in the AI Age: Organizing Psi Research with RAG"**
   - Target: "parapsychology research database"

### Blog Post Template

```tsx
import { Helmet } from 'react-helmet-async';

const BlogPost: React.FC<{ post: BlogPostData }> = ({ post }) => {
  return (
    <article>
      <Helmet>
        <title>{post.title} | Scrapalot Blog</title>
        <meta name="description" content={post.excerpt} />
        <meta name="keywords" content={post.keywords.join(', ')} />

        {/* Article Schema */}
        <script type="application/ld+json">
          {JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": post.title,
            "image": post.featuredImage,
            "author": {
              "@type": "Person",
              "name": post.author
            },
            "publisher": {
              "@type": "Organization",
              "name": "Scrapalot",
              "logo": {
                "@type": "ImageObject",
                "url": "https://scrapalot.com/logo.png"
              }
            },
            "datePublished": post.publishedDate,
            "dateModified": post.modifiedDate,
            "description": post.excerpt
          })}
        </script>
      </Helmet>

      <header>
        <h1>{post.title}</h1>
        <time dateTime={post.publishedDate}>{formatDate(post.publishedDate)}</time>
      </header>

      <div className="prose" dangerouslySetInnerHTML={{ __html: post.content }} />
    </article>
  );
};
```

## Task 8: Technical SEO Checklist

### Sitemap Generation

```xml
<!-- public/sitemap.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://scrapalot.com/</loc>
    <lastmod>2025-01-16</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://scrapalot.com/about</loc>
    <lastmod>2025-01-16</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://scrapalot.com/pricing</loc>
    <lastmod>2025-01-16</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
  <!-- Add consciousness-specific landing pages -->
  <url>
    <loc>https://scrapalot.com/consciousness-research</loc>
    <lastmod>2025-01-16</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>
```

### Robots.txt

```
# public/robots.txt
User-agent: *
Allow: /
Allow: /about
Allow: /pricing
Allow: /consciousness-research
Allow: /spiritual-texts
Allow: /metaphysics-research
Allow: /parapsychology

Disallow: /sign-up
Disallow: /login
Disallow: /app/*
Disallow: /dashboard/*

Sitemap: https://scrapalot.com/sitemap.xml
```

## Best Practices

### 1. Avoid Keyword Stuffing

```tsx
// ❌ BAD - Keyword stuffing
<h1>
  Consciousness Research AI Tool for Consciousness Studies and
  Consciousness Analysis with AI Consciousness Research Platform
</h1>

// GOOD - Natural language
<h1>
  AI-Powered Research Platform for Consciousness Studies
</h1>
<p>
  Explore meditation research, altered states, and neuroscience of
  consciousness with advanced semantic search and knowledge graphs.
</p>
```

### 2. Mobile-First Design

```tsx
// Ensure responsive meta viewport
<Helmet>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</Helmet>

// Use mobile-friendly layouts
<section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  {/* Responsive grid */}
</section>
```

### 3. Monitor Core Web Vitals

- **LCP (Largest Contentful Paint)**: < 2.5s
- **FID (First Input Delay)**: < 100ms
- **CLS (Cumulative Layout Shift)**: < 0.1

Use Lighthouse and Google Search Console to track performance.

## Monitoring & Analytics

### Google Analytics 4

```tsx
<Helmet>
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
  <script>
    {`
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-XXXXXXXXXX');
    `}
  </script>
</Helmet>
```

### Track Niche-Specific Events

```typescript
// Track consciousness research interest
gtag('event', 'feature_interest', {
  event_category: 'Consciousness Research',
  event_label: 'Deep Research Mode Clicked'
});

// Track spiritual texts engagement
gtag('event', 'feature_interest', {
  event_category: 'Spiritual Texts',
  event_label: 'Sacred Texts Demo Viewed'
});
```

## Reference

- **Google Search Console**: Monitor consciousness/spirituality keyword rankings
- **SEMrush/Ahrefs**: Find long-tail keywords in metaphysics/consciousness niches
- **Schema.org**: https://schema.org/
- **React Helmet Async**: https://github.com/staylor/react-helmet-async
- **Web Vitals**: https://web.dev/vitals/
