import React, { useRef, useEffect } from 'react';

interface FluidAnimationProps {
  accentColor: string;
}

export const FluidAnimation: React.FC<FluidAnimationProps> = ({
  accentColor,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const resizeCanvas = () => {
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    };
    resizeCanvas();

    // Fluid simulation grid
    const GRID_SIZE = 8;
    const cols = Math.floor(canvas.width / GRID_SIZE);
    const rows = Math.floor(canvas.height / GRID_SIZE);

    // Velocity fields
    const velocityX = new Array(cols * rows).fill(0);
    const velocityY = new Array(cols * rows).fill(0);
    const prevVelocityX = new Array(cols * rows).fill(0);
    const prevVelocityY = new Array(cols * rows).fill(0);

    // Density field
    const density = new Array(cols * rows).fill(0);
    const prevDensity = new Array(cols * rows).fill(0);

    // Mouse state
    let mouseX = 0;
    let mouseY = 0;
    let prevMouseX = 0;
    let prevMouseY = 0;

    // Get accent color
    const getColor = (accent: string): [number, number, number] => {
      switch (accent) {
        case 'red':
          return [255, 100, 120];
        case 'blue':
          return [100, 150, 255];
        case 'green':
          return [120, 255, 150];
        case 'orange':
          return [255, 150, 100];
        case 'violet':
          return [200, 120, 255];
        default:
          return [200, 120, 255];
      }
    };

    const [r, g, b] = getColor(accentColor);

    // Grid index helper
    const IX = (x: number, y: number) => {
      x = Math.max(0, Math.min(cols - 1, x));
      y = Math.max(0, Math.min(rows - 1, y));
      return x + y * cols;
    };

    // Add velocity at position
    const addVelocity = (x: number, y: number, vx: number, vy: number) => {
      const cellX = Math.floor(x / GRID_SIZE);
      const cellY = Math.floor(y / GRID_SIZE);
      if (cellX >= 0 && cellX < cols && cellY >= 0 && cellY < rows) {
        const index = IX(cellX, cellY);
        velocityX[index] += vx;
        velocityY[index] += vy;
      }
    };

    // Add density at position
    const addDensity = (x: number, y: number, amount: number) => {
      const cellX = Math.floor(x / GRID_SIZE);
      const cellY = Math.floor(y / GRID_SIZE);
      if (cellX >= 0 && cellX < cols && cellY >= 0 && cellY < rows) {
        const index = IX(cellX, cellY);
        density[index] += amount;
      }
    };

    // Diffusion step
    const diffuse = (x: number[], x0: number[], diff: number) => {
      const a = diff * cols * rows;
      for (let k = 0; k < 4; k++) {
        for (let j = 1; j < rows - 1; j++) {
          for (let i = 1; i < cols - 1; i++) {
            x[IX(i, j)] =
              (x0[IX(i, j)] +
                a *
                  (x[IX(i + 1, j)] +
                    x[IX(i - 1, j)] +
                    x[IX(i, j + 1)] +
                    x[IX(i, j - 1)])) /
              (1 + 4 * a);
          }
        }
      }
    };

    // Advection step
    const advect = (d: number[], d0: number[], u: number[], v: number[]) => {
      for (let j = 1; j < rows - 1; j++) {
        for (let i = 1; i < cols - 1; i++) {
          let x = i - u[IX(i, j)];
          let y = j - v[IX(i, j)];

          if (x < 0.5) x = 0.5;
          if (x > cols - 1.5) x = cols - 1.5;
          if (y < 0.5) y = 0.5;
          if (y > rows - 1.5) y = rows - 1.5;

          const i0 = Math.floor(x);
          const i1 = i0 + 1;
          const j0 = Math.floor(y);
          const j1 = j0 + 1;

          const s1 = x - i0;
          const s0 = 1 - s1;
          const t1 = y - j0;
          const t0 = 1 - t1;

          d[IX(i, j)] =
            s0 * (t0 * d0[IX(i0, j0)] + t1 * d0[IX(i0, j1)]) +
            s1 * (t0 * d0[IX(i1, j0)] + t1 * d0[IX(i1, j1)]);
        }
      }
    };

    // Simulation step
    const step = () => {
      // Add mouse influence
      const forceMultiplier = 50;
      addVelocity(
        mouseX,
        mouseY,
        (mouseX - prevMouseX) * forceMultiplier,
        (mouseY - prevMouseY) * forceMultiplier
      );
      addDensity(mouseX, mouseY, 300);

      // Add smoke source at bottom
      for (let i = 0; i < 3; i++) {
        const x = canvas.width * 0.3 + Math.random() * canvas.width * 0.4;
        const y = canvas.height - 30;
        addDensity(x, y, 100);
        addVelocity(x, y, (Math.random() - 0.5) * 10, -20);
      }

      // Velocity step
      diffuse(prevVelocityX, velocityX, 0.0001);
      diffuse(prevVelocityY, velocityY, 0.0001);

      // Swap arrays
      [velocityX, prevVelocityX] = [prevVelocityX, velocityX];
      [velocityY, prevVelocityY] = [prevVelocityY, velocityY];

      advect(velocityX, prevVelocityX, prevVelocityX, prevVelocityY);
      advect(velocityY, prevVelocityY, prevVelocityX, prevVelocityY);

      // Density step
      diffuse(prevDensity, density, 0.0001);
      [density, prevDensity] = [prevDensity, density];
      advect(density, prevDensity, velocityX, velocityY);

      // Dissipation
      for (let i = 0; i < density.length; i++) {
        density[i] *= 0.995; // Fade out
        velocityX[i] *= 0.99; // Velocity decay
        velocityY[i] *= 0.99;
      }
    };

    // Render
    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const d = density[IX(i, j)];
          if (d > 1) {
            const alpha = Math.min(0.8, d * 0.005);
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
            ctx.fillRect(i * GRID_SIZE, j * GRID_SIZE, GRID_SIZE, GRID_SIZE);
          }
        }
      }
    };

    // Mouse tracking
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      prevMouseX = mouseX;
      prevMouseY = mouseY;
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
    };

    canvas.addEventListener('mousemove', handleMouseMove);

    // Animation loop
    const animate = () => {
      step();
      render();
      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      canvas.removeEventListener('mousemove', handleMouseMove);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [accentColor]);

  return (
    <canvas
      ref={canvasRef}
      className='absolute inset-0 w-full h-full pointer-events-none'
      style={{
        zIndex: 1,
        opacity: 0.6,
      }}
    />
  );
};
