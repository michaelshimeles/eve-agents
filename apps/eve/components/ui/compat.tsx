"use client";

import { Button as FrostedButton, IconButton, Spinner } from "frosted-ui";
import { isValidElement, type ComponentProps, type ComponentType, type ReactNode } from "react";

import { cn } from "@/lib/utils";

// Thin adapters exposing the old Kumo component APIs on top of Frosted UI,
// so the chat surfaces keep their call sites (variant="ghost", icon={X},
// shape="square", <Loader size={14} />) while rendering Whop-styled controls.

type CompatVariant = "primary" | "secondary" | "ghost" | "destructive" | "outline";
type CompatSize = "xs" | "sm" | "base" | "lg";

type FrostedVariant = ComponentProps<typeof FrostedButton>["variant"];
type FrostedColor = ComponentProps<typeof FrostedButton>["color"];
type FrostedSize = ComponentProps<typeof FrostedButton>["size"];

const VARIANTS: Record<CompatVariant, { variant: FrostedVariant; color?: FrostedColor }> = {
  primary: { variant: "classic" },
  secondary: { variant: "surface", color: "gray" },
  outline: { variant: "surface", color: "gray" },
  ghost: { variant: "ghost", color: "gray" },
  destructive: { variant: "solid", color: "red" },
};

const SIZES: Record<CompatSize, FrostedSize> = { xs: "1", sm: "2", base: "3", lg: "4" };

const ICON_SIZES: Record<CompatSize, string> = {
  xs: "size-3.5",
  sm: "size-4",
  base: "size-4",
  lg: "size-5",
};

interface CompatButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  variant?: CompatVariant;
  size?: CompatSize;
  shape?: "square" | "circle";
  /** A component (sized here) or a ready element (sized by a wrapper). */
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }> | ReactNode;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "base",
  shape,
  icon,
  children,
  className,
  ...props
}: CompatButtonProps) {
  const mapped = VARIANTS[variant];
  const frostedSize = SIZES[size];

  let iconNode: ReactNode = null;
  if (icon !== undefined && icon !== null) {
    if (isValidElement(icon)) {
      iconNode = (
        <span aria-hidden className={cn(ICON_SIZES[size], "[&>svg]:size-full")}>
          {icon}
        </span>
      );
    } else {
      const Icon = icon as ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
      iconNode = <Icon className={ICON_SIZES[size]} aria-hidden />;
    }
  }

  if (iconNode !== null && (children === undefined || children === null)) {
    return (
      <IconButton
        variant={mapped.variant}
        color={mapped.color}
        size={frostedSize}
        className={cn(shape === "circle" && "rounded-full", className)}
        {...props}
      >
        {iconNode}
      </IconButton>
    );
  }
  return (
    <FrostedButton
      variant={mapped.variant}
      color={mapped.color}
      size={frostedSize}
      className={className}
      {...props}
    >
      {iconNode}
      {children}
    </FrostedButton>
  );
}

interface CompatLinkButtonProps
  extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "color"> {
  variant?: CompatVariant;
  size?: CompatSize;
  /** Kumo appended an external-link affordance; Frosted handles rel safety. */
  external?: boolean;
  children?: ReactNode;
}

export function LinkButton({
  variant = "secondary",
  size = "base",
  external,
  className,
  children,
  ...props
}: CompatLinkButtonProps) {
  const mapped = VARIANTS[variant];
  return (
    <FrostedButton
      variant={mapped.variant}
      color={mapped.color}
      size={SIZES[size]}
      className={className}
      render={<a rel={external === true ? "noreferrer noopener" : undefined} {...props} />}
    >
      {children}
    </FrostedButton>
  );
}

/** Kumo's Loader took a pixel size; Frosted's Spinner uses a 1–6 scale. */
export function Loader({ size }: { size?: number }) {
  const scale = size === undefined ? "2" : size <= 14 ? "1" : size <= 18 ? "2" : "3";
  return <Spinner size={scale} />;
}
