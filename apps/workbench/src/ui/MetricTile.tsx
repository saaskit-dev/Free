import { Text, View } from "react-native";

import { common, colors, typography } from "./theme";

type MetricTileProps = {
  accent: string;
  label: string;
  value: string;
};

export function MetricTile({ accent, label, value }: MetricTileProps) {
  return (
    <View style={[common.panel, { flex: 1, minWidth: 150, padding: 16 }]}>
      <View style={{ width: 30, height: 6, backgroundColor: accent, marginBottom: 18 }} />
      <Text style={[common.eyebrow, { marginBottom: 8 }]}>{label}</Text>
      <Text style={{ color: colors.ink, fontFamily: typography.display, fontSize: 32 }}>
        {value}
      </Text>
    </View>
  );
}
