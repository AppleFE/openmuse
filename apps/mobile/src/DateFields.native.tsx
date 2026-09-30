import { View } from "react-native";
import { Field } from "./ui";
export interface DateFieldsProps {
  label: string;
  date: string;
  time: string;
  allDay: boolean;
  onChange: (date: string, time: string) => void;
}
export default function DateFields({ label, date, time, allDay, onChange }: DateFieldsProps) {
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <View style={{ flex: 1.2 }}>
        <Field
          label={`${label} 날짜`}
          value={date}
          onChangeText={(value) => onChange(value, time)}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
        />
      </View>
      {!allDay && (
        <View style={{ flex: 1 }}>
          <Field
            label={`${label} 시간`}
            value={time}
            onChangeText={(value) => onChange(date, value)}
            placeholder="시:분(24시간)"
            keyboardType="numbers-and-punctuation"
          />
        </View>
      )}
    </View>
  );
}
