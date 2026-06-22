import React, { useEffect, useRef } from 'react';

interface AccentColorEntry {
  dark: string;
  light: string;
}

/** Returns the dark/light color template strings for the given accent color. */
function getAccentColor(accentColor: string, isDarkMode: boolean): string {
  const map: Record<string, AccentColorEntry> = {
    gray:   { dark: 'rgba(161, 161, 170, opacity)', light: 'rgba(113, 113, 122, opacity)' },
    blue:   { dark: 'rgba(59, 130, 246, opacity)',  light: 'rgba(37, 99, 235, opacity)'  },
    green:  { dark: 'rgba(16, 185, 129, opacity)',  light: 'rgba(5, 150, 105, opacity)'  },
    red:    { dark: 'rgba(239, 68, 68, opacity)',   light: 'rgba(220, 38, 38, opacity)'  },
    violet: { dark: 'rgba(199, 162, 255, opacity)', light: 'rgba(99, 88, 223, opacity)'  },
    orange: { dark: 'rgba(249, 115, 22, opacity)',  light: 'rgba(234, 88, 12, opacity)'  },
  };
  const entry = map[accentColor] ?? map.gray;
  return isDarkMode ? entry.dark : entry.light;
}

/** Returns the glow color (fixed opacity) for the given accent color. */
function getAccentGlowColor(accentColor: string, isDarkMode: boolean): string {
  const map: Record<string, AccentColorEntry> = {
    gray:   { dark: 'rgba(161, 161, 170, 0.6)', light: 'rgba(113, 113, 122, 0.5)' },
    blue:   { dark: 'rgba(59, 130, 246, 0.6)',  light: 'rgba(37, 99, 235, 0.5)'  },
    green:  { dark: 'rgba(16, 185, 129, 0.6)',  light: 'rgba(5, 150, 105, 0.5)'  },
    red:    { dark: 'rgba(239, 68, 68, 0.6)',   light: 'rgba(220, 38, 38, 0.5)'  },
    violet: { dark: 'rgba(199, 162, 255, 0.6)', light: 'rgba(99, 88, 223, 0.5)'  },
    orange: { dark: 'rgba(249, 115, 22, 0.6)',  light: 'rgba(234, 88, 12, 0.5)'  },
  };
  const entry = map[accentColor] ?? map.gray;
  return isDarkMode ? entry.dark : entry.light;
}

/** Returns the particle color template string for the given accent color. */
function getParticleColor(accentColor: string, isDarkMode: boolean): string {
  const map: Record<string, AccentColorEntry> = {
    gray:   { dark: 'rgba(161, 161, 170, opacity)', light: 'rgba(113, 113, 122, opacity)' },
    blue:   { dark: 'rgba(59, 130, 246, opacity)',  light: 'rgba(37, 99, 235, opacity)'  },
    green:  { dark: 'rgba(16, 185, 129, opacity)',  light: 'rgba(5, 150, 105, opacity)'  },
    red:    { dark: 'rgba(239, 68, 68, opacity)',   light: 'rgba(220, 38, 38, opacity)'  },
    violet: { dark: 'rgba(168, 85, 247, opacity)',  light: 'rgba(67, 56, 202, opacity)'  },
    orange: { dark: 'rgba(249, 115, 22, opacity)',  light: 'rgba(234, 88, 12, opacity)'  },
  };
  const entry = map[accentColor] ?? map.gray;
  return isDarkMode ? entry.dark : entry.light;
}

/** Returns the particle glow color (fixed opacity) for the given accent color. */
function getParticleGlowColor(accentColor: string, isDarkMode: boolean): string {
  const map: Record<string, AccentColorEntry> = {
    gray:   { dark: 'rgba(161, 161, 170, 0.2)', light: 'rgba(113, 113, 122, 0.2)' },
    blue:   { dark: 'rgba(59, 130, 246, 0.2)',  light: 'rgba(37, 99, 235, 0.2)'  },
    green:  { dark: 'rgba(16, 185, 129, 0.2)',  light: 'rgba(5, 150, 105, 0.2)'  },
    red:    { dark: 'rgba(239, 68, 68, 0.2)',   light: 'rgba(220, 38, 38, 0.2)'  },
    violet: { dark: 'rgba(168, 85, 247, 0.2)',  light: 'rgba(67, 56, 202, 0.2)'  },
    orange: { dark: 'rgba(249, 115, 22, 0.2)',  light: 'rgba(234, 88, 12, 0.2)'  },
  };
  const entry = map[accentColor] ?? map.gray;
  return isDarkMode ? entry.dark : entry.light;
}

interface StarsAnimationProps {
  isDarkMode: boolean;
  accentColor: string;
}

const StarsAnimation: React.FC<StarsAnimationProps> = ({ isDarkMode, accentColor }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // 3D-like stars moving toward viewer
    const stars: {
      x: number;
      y: number;
      z: number;
      originalX: number;
      originalY: number;
      pulse: number;
      pulseSpeed: number;
    }[] = [];
    // Create stars with 3D coordinates
    const numStars = Math.floor((canvas.width * canvas.height) / 30000); // More stars for depth effect
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    for (let i = 0; i < numStars; i++) {
      const x = (Math.random() - 0.5) * canvas.width * 2; // Wider spread
      const y = (Math.random() - 0.5) * canvas.height * 2; // Wider spread
      const z = Math.random() * 1000 + 1; // Depth from 1 to 1001
      stars.push({
        x: x,
        y: y,
        z: z,
        originalX: x,
        originalY: y,
        pulse: Math.random() * Math.PI * 2,
        pulseSpeed: ((0.01 + Math.random() * 0.02) * (1000 - z)) / 500, // Closer stars pulse faster
      });
    }

    // Floating particles moving toward viewer
    const particles: {
      x: number;
      y: number;
      z: number;
      originalX: number;
      originalY: number;
      life: number;
      maxLife: number;
    }[] = [];

    // Trail system for stars - each star maintains its own trail queue
    const starTrails: Map<
      number,
      { x: number; y: number; size: number; color: string; age: number }[]
    > = new Map();
    const TRAIL_DURATION = 900; // 15 seconds at 60fps
    const MAX_TRAIL_LENGTH = 80; // Maximum trail points per star for longer trails

    const startAnimation = () => {
      const animate = () => {
        // Clear canvas completely
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Update and draw stars moving toward viewer
        stars.forEach((star, starIndex) => {
          // Closer stars move faster
          const speedMultiplier = (1000 - star.z) / 500;
          star.z -= 1.5 * (0.5 + speedMultiplier);

          // Reset star when it gets too close
          if (star.z <= 0) {
            star.z = 1000 + Math.random() * 500; // Reset to back
            star.x = star.originalX;
            star.y = star.originalY;
            // Clear trail when star resets
            starTrails.delete(starIndex);
          }

          // Calculate 3D projection
          const perspective = 300; // Perspective strength
          const projectedX = centerX + (star.x * perspective) / star.z;
          const projectedY = centerY + (star.y * perspective) / star.z;

          // Bigger size range for more dramatic depth effect
          const size = Math.max(0.3, Math.min(4, (1000 - star.z) / 200));

          // Calculate opacity based on distance and pulse
          star.pulse += star.pulseSpeed;
          const pulseIntensity = (Math.sin(star.pulse) + 1) / 2;
          const distanceOpacity = Math.max(0.1, (1000 - star.z) / 1000); // Closer = more visible
          const opacity = (0.1 + pulseIntensity * 0.3) * distanceOpacity;

          // Only draw if star is on screen
          if (
            projectedX >= -10 &&
            projectedX <= canvas.width + 10 &&
            projectedY >= -10 &&
            projectedY <= canvas.height + 10
          ) {
            // Get or create trail for this star
            if (!starTrails.has(starIndex)) {
              starTrails.set(starIndex, []);
            }
            const trail = starTrails.get(starIndex)!;

            // Add new trail point (head of trail)
            trail.push({
              x: projectedX,
              y: projectedY,
              size: size,
              color: (() => {
                const finalOpacity = isDarkMode ? opacity * 1.5 : opacity * 1.3;
                return getAccentColor(accentColor, isDarkMode).replace('opacity', finalOpacity.toString());
              })(),
              age: 0,
            });

            // Remove old trail points (keep only MAX_TRAIL_LENGTH points)
            if (trail.length > MAX_TRAIL_LENGTH) {
              trail.shift(); // Remove oldest (tail)
            }
          }

          // Always draw the current star (independent of trail system)
          if (
            projectedX >= -10 &&
            projectedX <= canvas.width + 10 &&
            projectedY >= -10 &&
            projectedY <= canvas.height + 10
          ) {
            // Draw current star
            ctx.beginPath();
            ctx.arc(projectedX, projectedY, size, 0, Math.PI * 2);

            const finalOpacity = isDarkMode ? opacity * 1.5 : opacity * 1.3;
            ctx.fillStyle = getAccentColor(accentColor, isDarkMode).replace('opacity', finalOpacity.toString());

            ctx.fill();

            // Add brighter glow for closer stars
            if (star.z < 200) {
              ctx.shadowColor = getAccentGlowColor(accentColor, isDarkMode);
              ctx.shadowBlur = size * 3;
              ctx.fill();
              ctx.shadowBlur = 0;
            }
          }
        });

        // Draw trails for all stars (tail fades first, head fades last)
        starTrails.forEach((trail, _starIndex) => {
          // Age all trail points
          trail.forEach((point) => point.age++);

          // Draw trail points from oldest (tail) to newest (head)
          trail.forEach((point, pointIndex) => {
            // Calculate fade based on position in trail (older = more faded)
            const positionRatio = pointIndex / (trail.length - 1); // 0 = tail, 1 = head
            const ageRatio = Math.min(point.age / TRAIL_DURATION, 1); // 0 = new, 1 = expired

            // Combine position and age fading: tail fades faster than head
            const fadeRatio = (1 - ageRatio) * (0.2 + 0.8 * positionRatio); // Tail gets 20% opacity, head gets 100%

            if (fadeRatio > 0.01) {
              // Only draw if visible
              const colorMatch = point.color.match(
                /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/
              );
              if (colorMatch) {
                const [, r, g, b, originalOpacity] = colorMatch;
                const trailOpacity = fadeRatio * parseFloat(originalOpacity);
                const fadedColor = `rgba(${r}, ${g}, ${b}, ${trailOpacity})`;

                ctx.beginPath();
                ctx.arc(
                  point.x,
                  point.y,
                  point.size * fadeRatio,
                  0,
                  Math.PI * 2
                );
                ctx.fillStyle = fadedColor;
                ctx.fill();
              }
            }
          });

          // Remove expired trail points (older than 10 seconds)
          for (let i = trail.length - 1; i >= 0; i--) {
            if (trail[i].age >= TRAIL_DURATION) {
              trail.splice(i, 1);
            }
          }
        });

        // Add occasional floating particles moving toward viewer
        if (Math.random() < 0.01) {
          // Less frequent
          const angle = Math.random() * Math.PI * 2;
          const distance = Math.random() * 400 + 200; // Distance from center
          particles.push({
            x: Math.cos(angle) * distance,
            y: Math.sin(angle) * distance,
            z: 800 + Math.random() * 400, // Start far away
            originalX: Math.cos(angle) * distance,
            originalY: Math.sin(angle) * distance,
            life: 0,
            maxLife: 400 + Math.random() * 200,
          });
        }

        // Update and draw particles moving toward viewer
        for (let i = particles.length - 1; i >= 0; i--) {
          const particle = particles[i];

          // Move particle toward viewer
          particle.z -= 2; // Slightly faster than stars
          particle.life++;

          // Reset or remove particle
          if (particle.z <= 0 || particle.life >= particle.maxLife) {
            particles.splice(i, 1);
            continue;
          }

          // Calculate 3D projection
          const perspective = 300;
          const projectedX = centerX + (particle.x * perspective) / particle.z;
          const projectedY = centerY + (particle.y * perspective) / particle.z;

          // Calculate size and opacity based on distance
          const size = Math.max(0.5, (800 - particle.z) / 400);
          const lifeRatio = particle.life / particle.maxLife;
          const distanceOpacity = Math.max(0.1, (800 - particle.z) / 800);
          const opacity = Math.sin(lifeRatio * Math.PI) * 0.4 * distanceOpacity;

          // Only draw if particle is on screen
          if (
            projectedX >= -10 &&
            projectedX <= canvas.width + 10 &&
            projectedY >= -10 &&
            projectedY <= canvas.height + 10 &&
            opacity > 0.01
          ) {
            ctx.beginPath();
            ctx.arc(projectedX, projectedY, size, 0, Math.PI * 2);

            ctx.fillStyle = getParticleColor(accentColor, isDarkMode).replace('opacity', opacity.toString());
            ctx.fill();

            // Add trail effect for closer particles
            if (particle.z < 200) {
              ctx.shadowColor = getParticleGlowColor(accentColor, isDarkMode);
              ctx.shadowBlur = size * 3;
              ctx.fill();
              ctx.shadowBlur = 0;
            }
          }
        }

        animationRef.current = requestAnimationFrame(animate);
      };

      animate();
    };

    startAnimation();

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isDarkMode, accentColor]);

  return (
    <canvas
      ref={canvasRef}
      className='absolute inset-0 w-full h-full pointer-events-none'
      style={{ zIndex: 0 }}
    />
  );
};

export default StarsAnimation;
