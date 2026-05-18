import { useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Modal,
  Pressable,
  Text,
  View,
} from "react-native";

import type { LanguageMode } from "../types";
import { colors, common, typography } from "./theme";
import { t } from "../workbench/preferences";

type ConfirmDialogProps = {
  cancelLabel?: string;
  cancelDisabled?: boolean;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  confirmLoading?: boolean;
  description?: string;
  language: LanguageMode;
  onCancel: () => void;
  onConfirm: () => void;
  tone?: "danger" | "default";
  title: string;
  visible: boolean;
};

export function ConfirmDialog({
  cancelLabel,
  cancelDisabled,
  confirmLabel,
  confirmDisabled,
  confirmLoading,
  description,
  language,
  onCancel,
  onConfirm,
  tone = "default",
  title,
  visible,
}: ConfirmDialogProps) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, { duration: 150, toValue: 1, useNativeDriver: true }),
        Animated.timing(scaleAnim, { duration: 150, toValue: 1, useNativeDriver: true }),
      ]).start();
    } else {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.95);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (confirmLoading || cancelDisabled) return true;
      onCancel();
      return true;
    });
    return () => handler.remove();
  }, [cancelDisabled, confirmLoading, visible, onCancel]);

  const danger = tone === "danger";
  const disableCancel = Boolean(confirmLoading || cancelDisabled);
  const disableConfirm = Boolean(confirmLoading || confirmDisabled);

  return (
    <Modal
      animationType="fade"
      onRequestClose={disableCancel ? undefined : onCancel}
      transparent
      visible={visible}
    >
      <View style={overlayStyle}>
        <Animated.View style={{ opacity: fadeAnim, transform: [{ scale: scaleAnim }] }}>
          <View style={dialogStyle}>
            <Text style={titleStyle}>{title}</Text>
            {description ? (
              <Text style={descStyle}>{description}</Text>
            ) : null}
            <View style={actionsStyle}>
              <Pressable
                disabled={disableCancel}
                onPress={onCancel}
                style={[cancelBtnStyle, disableCancel ? disabledButtonStyle : null]}
              >
                <Text style={cancelBtnTextStyle}>
                  {cancelLabel ?? t(language, "取消", "Cancel")}
                </Text>
              </Pressable>
              <Pressable
                disabled={disableConfirm}
                onPress={onConfirm}
                style={[
                  confirmBtnStyle,
                  danger ? confirmDangerStyle : confirmDefaultStyle,
                  disableConfirm ? disabledButtonStyle : null,
                ]}
              >
                {confirmLoading ? (
                  <ActivityIndicator color={colors.paper} size="small" />
                ) : null}
                <Text style={[confirmBtnTextStyle, danger ? { color: colors.paper } : null]}>
                  {confirmLabel ?? t(language, "确认", "Confirm")}
                </Text>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const overlayStyle = {
  alignItems: "center" as const,
  backgroundColor: "rgba(0,0,0,0.4)",
  flex: 1,
  justifyContent: "center" as const,
  padding: 24,
};

const dialogStyle = {
  ...common.panel,
  backgroundColor: "#FFFDF7",
  maxWidth: 420,
  padding: 24,
  width: "100%" as const,
};

const titleStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 17,
  lineHeight: 22,
};

const descStyle = {
  color: colors.graphite,
  fontFamily: typography.sans,
  fontSize: 14,
  lineHeight: 20,
  marginTop: 8,
};

const actionsStyle = {
  flexDirection: "row" as const,
  gap: 10,
  justifyContent: "flex-end" as const,
  marginTop: 20,
};

const cancelBtnStyle = {
  alignItems: "center" as const,
  borderColor: colors.ink,
  borderRadius: 8,
  borderWidth: 1,
  height: 38,
  justifyContent: "center" as const,
  paddingHorizontal: 18,
};

const cancelBtnTextStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 13,
};

const confirmBtnStyle = {
  alignItems: "center" as const,
  borderRadius: 8,
  borderWidth: 1,
  flexDirection: "row" as const,
  gap: 8,
  height: 38,
  justifyContent: "center" as const,
  paddingHorizontal: 18,
};

const confirmDefaultStyle = {
  backgroundColor: colors.ink,
};

const confirmDangerStyle = {
  backgroundColor: colors.coral,
  borderColor: colors.ink,
};

const confirmBtnTextStyle = {
  color: colors.paper,
  fontFamily: typography.sansSemi,
  fontSize: 13,
};

const disabledButtonStyle = {
  opacity: 0.6,
};
