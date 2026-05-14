import {
  ActivityCircleIcon,
  ComputerIcon,
  Settings02Icon,
  UserShield01Icon,
} from "@hugeicons/core-free-icons";

import type { RouteId } from "../types";

export const routes: readonly {
  id: RouteId;
  icon: typeof UserShield01Icon;
}[] = [
  {
    id: "access",
    icon: UserShield01Icon,
  },
  {
    id: "sessions",
    icon: ActivityCircleIcon,
  },
  {
    id: "hosts",
    icon: ComputerIcon,
  },
  {
    id: "settings",
    icon: Settings02Icon,
  },
];
