import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button, colors, s } from "./ui";

interface PdfReaderProps {
  url: string;
  token: string;
  pageCount: number;
}
export default function PdfReader({ url, pageCount }: PdfReaderProps) {
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  return (
    <View style={{ gap: 12 }}>
      <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
        <View style={[s.row, { gap: 8 }]}>
          <Button small icon={ChevronLeft} disabled={page <= 1} onPress={() => setPage(page - 1)}>
            이전
          </Button>
          <Text style={s.small}>
            {page} / {pageCount}
          </Text>
          <Button
            small
            icon={ChevronRight}
            disabled={page >= pageCount}
            onPress={() => setPage(page + 1)}
          >
            다음
          </Button>
        </View>
        <View style={[s.row, { gap: 8 }]}>
          <Button small icon={Minus} disabled={zoom <= 50} onPress={() => setZoom(zoom - 25)}>
            축소
          </Button>
          <Text style={s.small}>{zoom}%</Text>
          <Button small icon={Plus} disabled={zoom >= 200} onPress={() => setZoom(zoom + 25)}>
            확대
          </Button>
        </View>
      </View>
      <iframe
        key={`${page}:${zoom}`}
        title="PDF 문서 뷰어"
        src={`${url}#page=${page}&zoom=${zoom}`}
        style={{
          height: 570,
          width: "100%",
          border: 0,
          borderRadius: 12,
          background: colors.surfaceMuted,
        }}
      />
      <Text style={s.small}>뷰어 도구 모음에서 사본을 다운로드하거나 인쇄할 수 있습니다.</Text>
    </View>
  );
}
