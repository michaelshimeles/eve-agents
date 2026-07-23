import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const markerVariants = cva(
  "group/marker relative flex min-h-4 w-full items-center gap-2 text-left text-sm/relaxed text-gray-11 [&_svg:not([class*='size-'])]:size-3.5 [a]:underline [a]:underline-offset-3 [a]:hover:text-gray-12",
  {
    variants: {
      variant: {
        default: "",
        separator:
          "before:mr-1 before:h-px before:min-w-0 before:flex-1 before:bg-gray-a4 after:ml-1 after:h-px after:min-w-0 after:flex-1 after:bg-gray-a4",
        border: "border-b border-gray-a4 pb-2",
      },
    },
  }
)

function Marker({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof markerVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(markerVariants({ variant, className })),
      },
      props
    ),
    render,
    state: {
      slot: "marker",
      variant,
    },
  })
}

function MarkerIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-icon"
      aria-hidden="true"
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center [&_svg:not([class*='size-'])]:size-3.5",
        className
      )}
      {...props}
    />
  )
}

function MarkerContent({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-content"
      className={cn(
        "min-w-0 wrap-break-word group-data-[variant=separator]/marker:flex-none group-data-[variant=separator]/marker:text-center *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-gray-12",
        className
      )}
      {...props}
    />
  )
}

export { Marker, MarkerIcon, MarkerContent, markerVariants }
