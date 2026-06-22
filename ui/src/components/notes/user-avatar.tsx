import React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { profilePicSources } from '@/lib/profile-picture';

interface UserAvatarProps {
  name: string;
  email?: string;
  /** Raw stored reference (filename / data-upload path / absolute URL) — resolved via profilePicSources. */
  avatar?: string;
  color?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  showName?: boolean;
}

// Generate initials from name
const getInitials = (name: string): string => {
  return name
    .split(' ')
    .map(word => word.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

// Generate consistent color from name
const getColorFromName = (name: string): string => {
  const colors = [
    '#958DF1', // Purple
    '#F98181', // Red  
    '#FBBC88', // Orange
    '#FAF594', // Yellow
    '#70CFF8', // Blue
    '#94FADB', // Teal
    '#B9F18D', // Green
    '#FF9F7D', // Coral
    '#A78BFA', // Lavender
    '#F472B6', // Pink
  ];
  
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  return colors[Math.abs(hash) % colors.length];
};

export const UserAvatar: React.FC<UserAvatarProps> = ({
  name,
  email: _email,
  avatar,
  color,
  size = 'md',
  className,
  showName = false
}) => {
  const initials = getInitials(name);
  const backgroundColor = color || getColorFromName(name);
  
  const sizeClasses = {
    xs: 'h-3 w-3 text-xs',
    sm: 'h-6 w-6 text-xs',
    md: 'h-8 w-8 text-sm', 
    lg: 'h-10 w-10 text-base'
  };

  // `className` is applied to the round Avatar itself (not the flex
  // wrapper) so visual modifiers like `ring-1 ring-background` follow
  // the circle shape instead of forming a square halo around the row.
  const avatarEl = (
    <Avatar className={cn(sizeClasses[size], className)}>
      {avatar && <AvatarImage {...profilePicSources(avatar)} alt={name} />}
      <AvatarFallback
        className="font-medium text-white border-0"
        style={{ backgroundColor }}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );

  if (!showName) return avatarEl;

  return (
    <div className="flex items-center gap-2">
      {avatarEl}
      <span className="text-sm font-medium text-foreground truncate">
        {name}
      </span>
    </div>
  );
};