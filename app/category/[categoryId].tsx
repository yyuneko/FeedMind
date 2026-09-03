import { useLocalSearchParams } from 'expo-router';
import { CollectionScreen } from '@/screens/CollectionScreen';
export default function CategoryRoute() { const { categoryId } = useLocalSearchParams<{ categoryId: string }>(); return <CollectionScreen collection={{ kind: 'category', categoryId }} />; }
