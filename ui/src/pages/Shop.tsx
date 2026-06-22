import React from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Coffee,
  Package,
  Shield,
  ShoppingCart,
  Star,
  Truck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import SharedHeader from '@/components/shared/header';
import { useTheme } from '@/providers/theme-provider';
import { useCart } from '@/contexts/cart-context';
import { toast } from '@/lib/toast-compat';
import {
  AuroraBackground,
  LandingFooter,
  SpotlightCard,
} from '@/components/landing';

const PRODUCTS = [
  {
    id: 1,
    name: 'Scrapalot AI Coffee Cup',
    description:
      'Premium insulated coffee cup with the iconic Scrapalot AI logo. Perfect for your daily coding sessions.',
    price: '$10.99',
    originalPrice: '$16.99',
    image: '/product/scrapalot-cup.png',
    rating: 4.8,
    reviews: 127,
    features: [
      'Double-wall insulation',
      'Leak-proof lid',
      'Premium matte finish',
      '12oz capacity',
    ],
    badge: 'Best Seller',
    inStock: true,
  },
  {
    id: 2,
    name: 'Scrapalot AI T-Shirt',
    description:
      'Comfortable cotton t-shirt featuring the Scrapalot AI hexagonal logo design.',
    price: '$12.99',
    originalPrice: '$16.99',
    image: '/product/scrapalot-tshirt.jpg',
    rating: 4.6,
    reviews: 89,
    features: [
      '100% cotton',
      'Unisex fit',
      'Machine washable',
      'Multiple sizes',
    ],
    badge: 'New',
    inStock: true,
  },
  {
    id: 3,
    name: 'Scrapalot AI Sticker Pack',
    description:
      'High-quality vinyl stickers perfect for laptops, water bottles, and more.',
    price: '$9.99',
    originalPrice: '$12.99',
    image: '/product/scrapalot-stickers.jpg',
    rating: 4.9,
    reviews: 203,
    features: [
      'Waterproof vinyl',
      'UV resistant',
      '10 unique designs',
      'Easy application',
    ],
    badge: 'Popular',
    inStock: true,
  },
];

const PERKS = [
  { icon: Truck, label: 'Free Shipping' },
  { icon: Shield, label: 'Quality Guarantee' },
  { icon: Package, label: 'Fast Delivery' },
];

const Shop: React.FC = () => {
  const { t } = useTranslation();
  const { theme, accentColor } = useTheme();
  const { addItem } = useCart();
  const isDarkMode = theme === 'dark';

  return (
    <div data-testid='page-shop-container' className='landing-page min-h-screen'>
      <SharedHeader isDarkMode={isDarkMode} accentColor={accentColor} />

      {/* Hero Section */}
      <section className='relative overflow-hidden'>
        <AuroraBackground variant='hero' />
        <div className='relative mx-auto max-w-7xl px-4 pb-14 pt-36 text-center sm:px-6 sm:pt-40 lg:px-8'>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          >
            <div className='landing-eyebrow mb-5 flex items-center justify-center gap-2 text-primary'>
              <Coffee className='h-3.5 w-3.5' />
              Official merch
            </div>
            <h1 className='font-display text-5xl font-medium leading-[1.05] tracking-tight sm:text-6xl'>
              The Scrapalot <span className='landing-gradient-text italic'>shop</span>
            </h1>
            <p className='mx-auto mt-6 max-w-2xl text-base leading-relaxed opacity-70 sm:text-lg'>
              Show your love for intelligent data processing with our premium
              merchandise collection. Every purchase supports the development of
              Scrapalot AI.
            </p>
          </motion.div>

          {/* Perks */}
          <motion.div
            className='mx-auto mt-10 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3'
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15, ease: 'easeOut' }}
          >
            {PERKS.map(perk => (
              <div
                key={perk.label}
                className='landing-glass flex items-center justify-center gap-2.5 px-4 py-3'
              >
                <perk.icon className='h-4 w-4 text-primary' />
                <span className='font-mono text-xs tracking-wide opacity-75'>{perk.label}</span>
              </div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* Products Grid */}
      <section className='pb-24'>
        <div className='mx-auto max-w-7xl px-4 sm:px-6 lg:px-8'>
          <div className='grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3'>
            {PRODUCTS.map((product, index) => (
              <motion.div
                key={product.id}
                initial={{ opacity: 0, y: 28 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.5, delay: index * 0.08, ease: 'easeOut' }}
              >
                <SpotlightCard
                  data-testid={`shop-product-card-${product.id}`}
                  className='group flex h-full flex-col'
                >
                  {/* Image */}
                  <div className='relative aspect-square overflow-hidden'>
                    {product.badge && (
                      <span className='absolute left-3 top-3 z-10 bg-primary px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-primary-foreground'>
                        {product.badge}
                      </span>
                    )}
                    <img
                      src={product.image}
                      alt={product.name}
                      className='h-full w-full object-cover object-center transition-transform duration-500 group-hover:scale-105'
                      onError={e => {
                        console.error(`Failed to load image: ${product.image}`);
                        const target = e.target as HTMLImageElement;
                        target.src = '/logo512.png';
                      }}
                    />
                    <div className='absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100' />
                  </div>

                  {/* Body */}
                  <div className='flex flex-1 flex-col p-6'>
                    <h3 className='text-lg font-semibold tracking-tight'>{product.name}</h3>
                    <p className='mt-1.5 text-sm leading-relaxed opacity-60'>
                      {product.description}
                    </p>

                    {/* Rating */}
                    <div className='mt-4 flex items-center gap-2'>
                      <div className='flex items-center'>
                        {[...Array(5)].map((_, i) => (
                          <Star
                            key={i}
                            className={`h-3.5 w-3.5 ${
                              i < Math.floor(product.rating)
                                ? 'fill-amber-400 text-amber-400'
                                : 'opacity-25'
                            }`}
                          />
                        ))}
                      </div>
                      <span className='font-mono text-[11px] opacity-50'>
                        {product.rating} ({product.reviews} reviews)
                      </span>
                    </div>

                    {/* Features */}
                    <div className='mt-4 space-y-1.5'>
                      {product.features.map(feature => (
                        <div key={feature} className='flex items-center gap-2 text-xs opacity-65'>
                          <span className='h-1 w-1 rounded-full bg-primary' />
                          {feature}
                        </div>
                      ))}
                    </div>

                    {/* Price */}
                    <div className='mt-5 flex items-baseline gap-2'>
                      <span className='font-display text-2xl font-medium'>{product.price}</span>
                      {product.originalPrice && (
                        <span className='text-sm opacity-40 line-through'>
                          {product.originalPrice}
                        </span>
                      )}
                    </div>

                    {/* CTA */}
                    <Button
                      data-testid={`shop-add-to-cart-${product.id}`}
                      className='landing-btn-primary mt-5 w-full py-3 text-sm font-medium'
                      disabled={!product.inStock}
                      onClick={() => {
                        if (product.inStock) {
                          addItem({
                            id: product.id.toString(),
                            name: product.name,
                            price: parseFloat(product.price.replace('$', '')),
                            image: product.image,
                          });
                          toast.success(t('toast.cart.itemAdded', { name: product.name }));
                        }
                      }}
                    >
                      <ShoppingCart className='mr-2 h-4 w-4' />
                      {product.inStock ? 'Add to Cart' : 'Out of Stock'}
                    </Button>
                  </div>
                </SpotlightCard>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className='relative pb-24'>
        <div className='mx-auto max-w-5xl px-4 sm:px-6 lg:px-8'>
          <motion.div
            className='landing-glass relative overflow-hidden px-6 py-14 text-center sm:px-16'
            initial={{ opacity: 0, y: 32 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          >
            <AuroraBackground variant='panel' />
            <div className='relative'>
              <h2 className='font-display text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl'>
                Support <span className='landing-gradient-text italic'>open source AI</span>
              </h2>
              <p className='mx-auto mt-4 max-w-xl text-base leading-relaxed opacity-70'>
                Every purchase helps fund the development of Scrapalot AI and keeps
                our tools free and open source.
              </p>
              <Button
                data-testid='shop-view-all-button'
                size='lg'
                className='landing-btn-primary mt-8 h-12 px-8 text-base font-medium'
              >
                View All Products
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      <LandingFooter testId='shop-footer' />
    </div>
  );
};

export default Shop;
