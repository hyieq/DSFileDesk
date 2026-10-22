import { LayoutGrid } from "lucide-react";
import ChoiceMenu from "./ChoiceMenu";
const options = [
  { value: "small", label: "小图标", hint: "紧凑排列", size: 12 },
  { value: "medium", label: "中等图标", hint: "均衡浏览", size: 15 },
  { value: "large", label: "大图标", hint: "细节预览", size: 18 },
  { value: "huge", label: "超大图标", hint: "大幅预览", size: 22 },
].map((o) => ({ ...o, icon: <LayoutGrid size={o.size} strokeWidth={1.6} /> }));
export default function ThumbnailMenu({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <ChoiceMenu
      value={value}
      onChange={onChange}
      options={options}
      label="缩略图大小"
      heading="显示大小"
    />
  );
}
