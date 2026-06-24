import { Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { promptRepo } from '@/db/repositories';
import { scheduleSync } from '@/services/sync';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function EditPromptScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const queryClient = useQueryClient();
  const themeColors = useThemeColors();
  const prompt = useQuery({ queryKey: ['prompt', id], enabled: Boolean(id), queryFn: () => promptRepo.get(id!) });
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [isDefault, setIsDefault] = useState(false);

  useEffect(() => {
    if (!prompt.data) return;
    setName(prompt.data.name);
    setContent(prompt.data.content);
    setIsDefault(prompt.data.isDefault);
  }, [prompt.data]);

  const save = async () => {
    if (!name.trim() || !content.trim()) {
      Alert.alert('请填写完整');
      return;
    }
    await promptRepo.save({ id, name: name.trim(), content: content.trim(), isDefault });
    scheduleSync();
    queryClient.invalidateQueries({ queryKey: ['prompts'] });
    router.back();
  };

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={screenStyles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={[screenStyles.link, { color: themeColors.blue }]}>Cancel</Text>
        </Pressable>
        <Text style={[screenStyles.navTitle, { color: themeColors.text }]}>Edit Prompt</Text>
        <Pressable onPress={save}>
          <Text style={[screenStyles.link, { color: themeColors.blue }]}>Save</Text>
        </Pressable>
      </View>
      <View style={screenStyles.content}>
        <Text style={[styles.label, { color: themeColors.secondary }]}>Name</Text>
        <TextInput value={name} onChangeText={setName} placeholder="李敖风格" placeholderTextColor={themeColors.subtle} style={[styles.nameInput, { borderColor: themeColors.border, color: themeColors.text }]} />
        <Text style={[styles.label, { color: themeColors.secondary }]}>Prompt</Text>
        <TextInput
          value={content}
          onChangeText={setContent}
          placeholder="你是译者。请用..."
          multiline
          textAlignVertical="top"
          placeholderTextColor={themeColors.subtle}
          style={[styles.promptInput, { borderColor: themeColors.border, color: themeColors.text }]}
        />
        <View style={styles.defaultRow}>
          <Text style={[styles.defaultText, { color: themeColors.text }]}>Set as Default</Text>
          <Switch value={isDefault} onValueChange={setIsDefault} />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  label: {
    color: colors.secondary,
    fontSize: 12,
    marginTop: 16,
    marginBottom: 7,
  },
  nameInput: {
    height: 42,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.text,
    fontSize: 13,
  },
  promptInput: {
    height: 186,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    color: colors.text,
    fontSize: 13,
    lineHeight: 20,
  },
  defaultRow: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
  },
  defaultText: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
  },
});
