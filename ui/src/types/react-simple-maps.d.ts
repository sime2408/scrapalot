declare module 'react-simple-maps' {
  import { ReactNode, CSSProperties } from 'react';

  interface ProjectionConfig {
    rotate?: [number, number, number];
    center?: [number, number];
    scale?: number;
    parallels?: [number, number];
  }

  interface StyleConfig {
    default?: CSSProperties;
    hover?: CSSProperties;
    pressed?: CSSProperties;
  }

  interface ComposableMapProps {
    projection?: string;
    projectionConfig?: ProjectionConfig;
    width?: number;
    height?: number;
    style?: CSSProperties;
    className?: string;
    children?: ReactNode;
  }

  interface GeographiesProps {
    geography: string | object;
    children: (props: { geographies: Geography[] }) => ReactNode;
    parseGeographies?: (geographies: Geography[]) => Geography[];
  }

  interface Geography {
    rsmKey: string;
    id?: string;
    properties: Record<string, string | number>;
    geometry: object;
    type: string;
  }

  interface GeographyProps {
    key?: string;
    geography: Geography;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    strokeOpacity?: number;
    style?: StyleConfig;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onClick?: () => void;
    className?: string;
    [key: string]: unknown;
  }

  interface MarkerProps {
    coordinates: [number, number];
    children?: ReactNode;
    style?: StyleConfig;
    className?: string;
  }

  interface GraticuleProps {
    stroke?: string;
    strokeWidth?: number;
    fill?: string;
    clipPath?: string;
  }

  interface SphereProps {
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
  }

  export const ComposableMap: React.FC<ComposableMapProps>;
  export const Geographies: React.FC<GeographiesProps>;
  export const Geography: React.FC<GeographyProps>;
  export const Marker: React.FC<MarkerProps>;
  export const Graticule: React.FC<GraticuleProps>;
  export const Sphere: React.FC<SphereProps>;
}
