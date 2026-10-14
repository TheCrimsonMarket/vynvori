// shadcn/ui button variant pattern, adapted to the approved square Archivo grammar.
// Links use buttonVariants directly to preserve native link semantics.
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export const buttonVariants = cva("button", {
  variants: { variant: { default: "button-primary", outline: "button-outline" } },
  defaultVariants: { variant: "default" },
});
export function Button({ className, variant, type = "button", ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant }), className)} {...props} />;
}
