import { HugeiconsIcon } from "@hugeicons/react-native";
import type { IconSvgElement } from "@hugeicons/react-native";

type IconProps = {
  color?: string;
  icon: IconSvgElement;
  size?: number;
  strokeWidth?: number;
};

export function Icon({ color = "#101014", icon, size = 20, strokeWidth = 2 }: IconProps) {
  return (
    <HugeiconsIcon
      color={color}
      icon={icon}
      size={size}
      strokeWidth={strokeWidth}
    />
  );
}
