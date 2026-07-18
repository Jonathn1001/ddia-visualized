# DDIA Visualized — Design Plan

**Một interactive learning lab biến toàn bộ ý tưởng của "Designing Data-Intensive Applications" thành mô phỏng trực quan, có thể phá, có thể nghịch.**

Version 1.1 — handoff-ready.

> **v1.1 changelog (post-review):** §6 chuyển thành Tech Stack — Final Decisions: loại XState (chốt pure reducer tự viết), React 18 → React 19, Framer Motion → package `motion`, thêm perf budget. §5 thêm cơ chế Timeline scrubber (hybrid snapshot + replay), Module contract v0, Determinism & input recording, rAF batching cho UI bridge. §1 thêm Non-goals. §3 chốt knowledge base in-repo MDX; đánh dấu citation-needed cho paper RAFT attack. §4 Ch9 ghi rõ thuật toán linearizability check. §9 thêm Definition of Done đo được cho Phase 0/1. §2 sửa citation Oddity. Thêm Appendix — Open Questions.

> **v1.2 (2026-07-10):** Từ v1.2, bản tiếng Anh `DESIGN_PLAN.en.md` là bản canonical — Story mode → annotated replay, contract v0.2, DoD Phase 1 v2, chốt deploy GitHub Pages. Bản tiếng Việt này giữ nguyên nội dung v1.1 làm tài liệu gốc.

---

## 1. Tầm nhìn sản phẩm

Vấn đề của việc đọc DDIA là: sách mô tả các hệ thống *động* (message bay qua mạng, node chết, log được replay) bằng phương tiện *tĩnh* (chữ và hình vẽ). Người đọc phải tự chạy simulation trong đầu — và đó chính là phần khó nhất.

DDIA Visualized đảo ngược điều đó: mỗi khái niệm trong sách trở thành một **simulation chạy được trong browser**, nơi bạn không chỉ *xem* hệ thống hoạt động mà còn *can thiệp* vào nó — giết node, làm chậm mạng, gửi write đồng thời — và quan sát hệ quả. Triết lý cốt lõi: **"Đừng đọc về split-brain. Hãy tự gây ra split-brain."**

Điểm khác biệt so với việc chỉ đọc: mỗi visualization được thiết kế quanh một *câu hỏi trade-off* và một *failure mode* — khớp trực tiếp với 3 câu hỏi định hướng của project học tập, và khớp với tư duy attacker/AppSec mà bạn đang rèn (hỏi "làm sao phá nó?" thay vì "nó chạy thế nào?").

### Non-goals — không build

- **Không backend / API server** — toàn bộ chạy client-side, deploy static.
- **Không user account / auth.**
- **Không persistence** ngoài `localStorage` + export/import file (action log, scenario).
- **Không mobile layout** — desktop-first; viewport nhỏ hiển thị thông báo chặn (kiểu `DesktopOnlyGate` của dbviz).
- **Không real database engine / production-accurate implementation** — đây là simulation giáo dục: bám paper gốc + TLA+ spec, không tái hiện chi tiết implementation của một hệ thống cụ thể nào.

## 2. Nghiên cứu prior art — người khác đã làm gì, và khoảng trống ở đâu

Khảo sát các dự án hiện có trên internet cho thấy một hệ sinh thái rời rạc nhưng nhiều bài học quý:

**The Secret Lives of Data (thesecretlivesofdata.com)** — chuẩn vàng của thể loại. Một visualization dạng guided tutorial cho Raft, dẫn người xem qua từng phase của thuật toán bằng animation SVG kèm narration từng bước. Bài học: **story-driven walkthrough** cực kỳ hiệu quả cho lần tiếp xúc đầu tiên với một thuật toán. Hạn chế: chỉ có Raft, không tương tác tự do.

**RaftScope (raft.github.io)** — một Raft cluster chạy ngay trong browser, 5 server hiển thị bên trái, log của chúng bên phải, cho phép người dùng tương tác trực tiếp. Chính trang Raft thừa nhận Secret Lives of Data là cách tiếp cận "guided và ít tương tác hơn, phù hợp làm điểm khởi đầu nhẹ nhàng hơn". Bài học: **sandbox tự do** là tầng học thứ hai, sau guided tour.

**visual.ofcoder.com** — mở rộng ý tưởng trên: có Basic-Paxos, Multi-Paxos, Raft và cả Basic-Kafka. Chứng minh format này scale được sang nhiều thuật toán, kể cả messaging system.

**CloudScope (University of Maryland)** — một distributed systems simulator dùng discrete event simulation cho message passing giữa các replica, mô tả network bằng JSON topology, generate workload, và render bằng SVG/JavaScript animation. Bài học kiến trúc quan trọng nhất: **tách simulation engine khỏi visualization layer** — engine chạy discrete events, UI chỉ là một consumer của event stream.

**Oddity (Doug Woos, University of Washington)** — graphical debugger cho distributed systems, dùng để tái hiện bug thật trong Raft reconfiguration. Bài học: khả năng **điều khiển thứ tự message** (delay, drop, reorder) chính là công cụ tạo insight sâu nhất.

**Các visualizer cấu trúc dữ liệu** (B+Tree visualizer của USF, các repo LSM-tree topic trên GitHub) — tồn tại rải rác nhưng tách rời khỏi ngữ cảnh "vì sao database chọn cấu trúc này".

**Khoảng trống thị trường:** đã có một GitHub topic `designing-data-intensive-applications` với vài repo React/TypeScript visualization, nhưng chưa có dự án nào (a) phủ đủ 12 chương thành một hành trình liền mạch, (b) kết hợp cả 3 mode guided/sandbox/chaos, (c) gắn mỗi simulation với trade-off và failure analysis theo đúng tinh thần DDIA. Đó là chỗ đứng của project này.

## 3. Concept thiết kế: mỗi chương = một Lab với 3 chế độ

Mỗi khái niệm được đóng gói thành một **Lab**. Mỗi Lab có cùng cấu trúc 3 tầng, đi từ thụ động đến chủ động:

**Mode 1 — Story (guided walkthrough).** Kiểu Secret Lives of Data: animation từng bước kèm lời dẫn, người dùng bấm Next để đi qua kịch bản chuẩn. Trả lời câu hỏi định hướng số 1: *dữ liệu được lưu, đọc, ghi, lan truyền thế nào?*

**Mode 2 — Sandbox (nghịch tự do).** Kiểu RaftScope: cluster/cấu trúc dữ liệu sống, người dùng gửi request, thêm dữ liệu, chỉnh tham số (số node, quorum size, memtable threshold...) và xem hệ thống phản ứng. Có **metrics panel** hiển thị real-time (throughput, latency, disk reads, replication lag) để trả lời câu hỏi số 2: *hệ thống đang đánh đổi cái gì?*

**Mode 3 — Chaos (fault injection).** Điểm nhấn riêng của project, lấy cảm hứng từ Jepsen và Oddity: người dùng có Chaos Toolbar để **kill node, partition mạng, delay/drop/duplicate/reorder message, làm lệch clock**. Mỗi Lab kèm 2–3 **Chaos Challenge** dạng nhiệm vụ: *"Hãy tạo ra một stale read"*, *"Hãy làm mất một write đã được ack"*, *"Hãy gây split-brain"*. Trả lời câu hỏi số 3: *khi hệ thống hỏng một phần, dữ liệu còn đúng không?* — và đây cũng chính là bài tập tư duy adversarial cho mục tiêu AppSec của bạn (một paper 2026 thậm chí đã phân tích RAFT dưới góc độ replay/forgery attack `[citation needed — tìm lại link]` — hướng mở rộng thú vị về sau).

Sau mỗi Lab là một trang **Debrief**: tóm tắt trade-off, ví dụ hệ thống thật (Postgres làm gì, Cassandra làm gì, Kafka làm gì), thuật ngữ, và link tới ghi chú chương tương ứng. Ghi chú chương sống **in-repo dạng MDX** tại `content/chapters/chNN/` — cùng pipeline MDX với Debrief (§5); việc sync ra hệ thống ngoài xem Appendix — Open Questions.

## 4. Bản đồ chương → visualization

| Ch. | Chủ đề sách | Lab visualization | Chaos challenge tiêu biểu |
|---|---|---|---|
| 1 | Reliability, Scalability, Maintainability | **Load simulator**: hệ thống web đơn giản, kéo slider tăng traffic, xem p50/p95/p99 latency vỡ ở đâu; thêm cache/replica để cứu | Tăng load đến khi tail latency bùng nổ; tìm bottleneck |
| 2 | Data models | **Model shape-shifter**: cùng một dữ liệu (social graph) render dưới dạng relational tables / JSON documents / graph; chạy cùng một query trên 3 model, so số bước | Query "bạn của bạn" trên document model — cảm nhận nỗi đau join |
| 3 | Storage engines | **LSM-tree vs B-tree side-by-side**: gõ key-value, xem memtable → SSTable flush → compaction, bloom filter check; bên cạnh là B-tree split page. Đồng hồ đếm disk I/O cho mỗi thao tác | Crash giữa lúc ghi — WAL cứu được gì? So write amplification hai bên |
| 4 | Encoding & evolution | **Schema evolution playground**: encode một record bằng JSON/Avro/Protobuf, xem byte layout; đổi schema, cho old reader đọc new data | Xóa một field bắt buộc — reader cũ nổ ở đâu? |
| 5 | Replication | **Replication theater**: leader-follower với async/sync toggle, multi-leader với conflict, leaderless với quorum r/w slider | Gây stale read với replication lag; write conflict trên multi-leader; sloppy quorum mất dữ liệu |
| 6 | Partitioning | **Consistent hashing ring**: thêm/bớt node xem key di chuyển; so hash vs range partitioning; hot key heatmap | Tạo hotspot bằng skewed workload; rebalance khi node chết |
| 7 | Transactions | **Isolation anomaly lab**: hai transaction chạy song song trên timeline kéo-thả, tự sắp thứ tự các operation để tạo dirty read, lost update, write skew; đổi isolation level xem anomaly nào bị chặn | Tái hiện write skew ở snapshot isolation (bài toán bác sĩ trực của Kleppmann) |
| 8 | Trouble with distributed systems | **Unreliable network playground**: gửi message qua mạng có delay/loss/reorder; process pause (GC) làm leader "tưởng mình còn sống"; clock skew giữa các node | Fencing token: chứng minh vì sao lock + lease không đủ |
| 9 | Consistency & consensus | **Linearizability checker + Raft**: nhập một history đọc/ghi, tool kiểm tra có linearizable không (checker dùng thuật toán Wing–Gong/Lowe, giới hạn history size — bài toán NP-hard trong trường hợp tổng quát); Raft election/log replication full sandbox | Gây network partition trong lúc election; minority partition có nhận write không? |
| 10 | Batch processing | **MapReduce flow**: dữ liệu chảy qua map → shuffle → reduce dưới dạng hạt animation; so với dataflow engine (bỏ materialization giữa các stage) | Kill một worker giữa job — recovery bằng cách nào? |
| 11 | Stream processing | **Kafka-style log**: producer/consumer group trên partitioned log, offset di chuyển, consumer rebalance; windowing (tumbling/hopping) trên event stream | Consumer crash sau khi xử lý nhưng trước khi commit offset → duplicate; exactly-once là gì? |
| 12 | Future of data systems | **Unbundled database**: ghép các Lab trước thành một pipeline CDC: OLTP write → changelog → search index + cache + analytics, xem một write lan truyền toàn hệ thống | Index đi trễ hơn source — người dùng thấy gì? |

Nguyên tắc chọn: mỗi Lab phải trả lời được cả 3 câu hỏi định hướng, và mỗi visualization phải có **ít nhất một con số đếm được** (disk I/O, message count, lag ms) — vì trade-off chỉ "thấm" khi nó định lượng được.

## 5. Kiến trúc kỹ thuật

Bài học lớn nhất từ CloudScope và Oddity: **simulation engine phải tách hoàn toàn khỏi rendering**, và phải **deterministic**.

```
┌─────────────────────────────────────────────────┐
│  UI Layer (React + Tailwind + Motion)            │
│  - SVG/Canvas renderers per lab                  │
│  - Timeline scrubber, Chaos toolbar, Metrics     │
└──────────────▲──────────────────────────────────┘
               │ event stream (subscribe)
┌──────────────┴──────────────────────────────────┐
│  Simulation Core (pure TypeScript, zero React)   │
│  - Discrete event loop + virtual clock           │
│  - Seeded PRNG → mọi run tái lập được            │
│  - SimNetwork: deliver/delay/drop/partition      │
│  - Node = pure reducer state machine (tự viết)   │
└──────────────▲──────────────────────────────────┘
               │ implements
┌──────────────┴──────────────────────────────────┐
│  Protocol/Structure modules (mỗi chương 1 module)│
│  lsm-tree · btree · replication · raft · 2pc ... │
└─────────────────────────────────────────────────┘
```

Các quyết định quan trọng:

**Discrete event simulation với virtual clock.** Không dùng `setTimeout` thật. Mọi thứ là event trong một priority queue theo virtual time. Lợi ích: (a) tua nhanh/chậm/pause tùy ý, (b) **timeline scrubber** — kéo ngược thời gian xem lại từng bước, đây là killer feature cho việc học, (c) test được bằng unit test bình thường.

**Timeline scrubber — cơ chế: hybrid snapshot + replay.** Snapshot toàn bộ sim state mỗi N events (N ≈ 500–1000, tune bằng benchmark ở Phase 0); scrub tới thời điểm *t* = restore snapshot gần nhất ≤ *t* rồi replay deterministic tới *t*. Ràng buộc kéo theo lên toàn bộ engine: **state phải immutable và serializable** (plain objects, structural sharing khi update), mọi side effect chỉ được phát sinh qua event queue — không có mutation ngoài luồng.

**Determinism qua seeded RNG.** Cùng seed + cùng chuỗi hành động = cùng kết quả. Cho phép: share một kịch bản bằng URL, viết Chaos Challenge có đáp án kiểm chứng được, và replay bug.

**Determinism & input recording.** Mọi user action (gửi write, kill node, kéo slider) đi vào simulation dưới dạng **event có virtual timestamp qua event queue** — không bao giờ mutate state trực tiếp. Nhờ đó mọi phiên sandbox đều ghi lại được thành action log. Share hai cấp: (a) **URL** `?seed=42&scenario=split-brain` cho scripted scenario có sẵn; (b) **action-log export/import JSON** cho phiên sandbox tự do — URL không chứa nổi một chuỗi hành động tùy ý.

**Node là state machine tường minh — pure reducer tự viết.** Mỗi node là một reducer thuần `(state, event) => [state', effects[]]`: nhận event → trả state mới + danh sách effect (message gửi đi, timer đặt). Đây chính là actor model, và cũng chính là cách sách mô tả các protocol — code sẽ đọc giống pseudocode trong paper. **Quyết định: không dùng XState.** Lý do: (a) không repo nào trong stack hiện tại dùng XState (đã kiểm tra toàn bộ `package.json` trong `~/Projects/Personal`); (b) XState v5 chạy actor/delay trên real timer mặc định — nhúng vào discrete event loop với virtual clock cần custom clock, mâu thuẫn trực tiếp nguyên tắc "không `setTimeout` thật" ở trên; (c) lợi ích "statechart tự render thành diagram" là overstated — Stately inspector là dev tool, không phải embed miễn phí trong app. Nếu Phase 3 (Raft) cho thấy statechart phức tạp cần công cụ, làm một spike XState-dưới-virtual-clock khi đó (xem Appendix — Open Questions).

**Module contract — deliverable số 1 của Phase 0.** "Mọi lab sau chỉ là plug-in" chỉ đúng khi contract được định nghĩa tường minh. v0.1 (đã validate bằng engine Phase 0, `src/engine/module.ts`):

```ts
interface SimModule<S, P> {
  id: string;                                       // 'lsm-tree' | 'raft' | ...
  chaos: ChaosCapability[];                         // vocabulary lab này hỗ trợ
  init(nodeId: NodeId, config: ModuleConfig, rng: SeededRng): S;
  reduce(state: S, event: ModuleEvent<P>, rng: SeededRng): [S, Effect[]]; // pure
  metrics(states: Map<NodeId, S>): MetricSample[];  // số đếm được cho panel
  inspect(state: S): InspectorTree;                 // state expose cho renderer
}
```

Chaos vocabulary tách hai họ: **network chaos** (kill node, partition, delay/drop/duplicate/reorder message, clock skew — cho các lab distributed) và **storage chaos** (crash-mid-write, torn write, disk-full — cho lab Chương 3 vốn không có network). Mỗi module declare capability nó hỗ trợ qua `chaos: ChaosCapability[]`; Chaos Toolbar render động theo declaration đó. Contract này được validate bằng hai lab đầu tiên (replication — network; LSM/B-tree — storage) trước khi coi là ổn định.

**Simulation chạy trong Web Worker** khi lab nặng (batch processing, cluster lớn) để không giật UI; postMessage event batch về main thread.

**UI bridge — batching chống re-render storm.** Sim event tần suất cao không đổ thẳng vào React: batch qua `requestAnimationFrame` trước khi ghi vào Zustand store, component subscribe theo selector hẹp. (Theo guideline re-renders trong `~/.claude/docs/react-best-practices.md`.)

**Rendering:** SVG + Motion cho phần lớn lab (node, message dots, log entries — bạn đã thạo Framer Motion/`motion`); Canvas chỉ khi cần vẽ hàng nghìn phần tử (particle flow của MapReduce). Không cần D3 full — chỉ mượn `d3-scale`/`d3-shape` khi cần.

**Metrics panel:** Recharts, nhận số liệu từ simulation core.

**Nội dung Debrief:** MDX — viết ghi chú như markdown nhưng nhúng được component simulation ngay trong bài.

## 6. Tech Stack — Final Decisions (khớp stack hiện tại của bạn)

- **Vite + React 19 + TypeScript strict.** (React 19 đã là chuẩn trong các project mới nhất: `trybuy-fe` `^19.1.1`, `fitness-tracker` `^19.2.6`.)
- **Tailwind** cho UI chrome.
- **`motion`** (tên package hiện hành của Framer Motion từ cuối 2024) cho animation.
- **Không XState** — protocol state machine tự viết dạng pure reducer; rationale đầy đủ ở §5.
- **Zustand** làm cầu nối state simulation ↔ React (nhẹ hơn Redux cho use case subscribe-heavy này), nhận update đã batch qua rAF (§5).
- **Vitest** cho simulation core — **mỗi protocol module phải có property-based test** (fast-check): ví dụ "sau mọi chuỗi partition/heal ngẫu nhiên, Raft không bao giờ có 2 leader cùng term". Đây vừa là bảo hiểm đúng đắn, vừa là bài học mini về cách Jepsen kiểm chứng hệ thống thật.
- **Deploy static** lên Vercel/GitHub Pages — toàn bộ chạy client-side, không cần backend.

**Perf budget:**

- Bundle ≤ 500 KB gzip cho app shell + engine (không tính MDX content; mỗi lab lazy-load theo route).
- 60 fps với ≤ 50 SVG node animated đồng thời; vượt ngưỡng → chuyển Canvas.
- Simulation core ≥ 10k events/s trong Web Worker.

## 7. Roadmap

**Phase 0 — Engine (1–2 tuần).** Event loop, virtual clock, seeded RNG, SimNetwork với delay/drop/partition, timeline recorder (snapshot + replay, §5), **module contract v0 (§5)**. Demo bằng ping-pong 3 node. *Đây là phần quyết định — làm kỹ, mọi lab sau chỉ là plug-in.*

**Phase 1 — Vertical slice: Chương 5 Replication (2–3 tuần).** Chọn replication làm lab đầu vì nó là trái tim của DDIA và dùng trọn engine. Đủ 3 mode + debrief + 3 chaos challenge. Ship xong slice này là đã validate toàn bộ concept.

**Phase 2 — Storage engines: Chương 3 (2 tuần).** LSM vs B-tree side-by-side với I/O counter. Khác biệt: lab này về data structure, không phải network — buộc engine phải tổng quát (và validate họ storage chaos của module contract).

**Phase 3 — Distributed core: Chương 6, 8, 9 (4–6 tuần).** Partitioning ring → unreliable network → Raft + linearizability checker. Cụm khó nhất và giá trị nhất.

**Phase 4 — Transactions: Chương 7 (2–3 tuần).** Isolation anomaly lab với timeline kéo-thả.

**Phase 5 — Data flow: Chương 10, 11, 12 + Chương 1, 2, 4 (4 tuần).** Kết bằng lab "unbundled database" ghép tất cả lại. *(ch12 shipped 2026-07-18 — 12.1 Unbundled Database: one write → append-only log → three lagging derived views [search index / cache / analytics]; single-node authoritative model; the three challenges are stale-read/RYW, rebuild-from-log, and exactly-once-via-offset-dedup — all engine-verified by the property + pinned-lesson suites. Phase 5 complete.)*

Nhịp làm việc gợi ý: **đọc chương → viết ghi chú → build lab của chương đó**. Việc build chính là active recall mạnh nhất — bạn không thể code Raft election nếu chưa thực sự hiểu nó, và mọi lỗ hổng hiểu biết sẽ lộ ra ngay khi test fail.

## 8. Rủi ro & cách né

**Scope creep** là rủi ro số một — 12 chương × 3 mode là rất nhiều. Phòng ngừa: ranh giới cứng ở Non-goals (§1); Story mode có thể chỉ là sandbox + script sẵn (cùng engine, khác data), và chấp nhận một số chương (2, 4) chỉ cần mini-widget thay vì full lab. **Đúng đắn của protocol**: đừng tự chế Raft từ trí nhớ — bám sát paper gốc + TLA+ spec, và để property test làm trọng tài. **Cầu toàn animation**: ship với animation "đủ hiểu" trước, đẹp sau; giá trị nằm ở simulation, không nằm ở easing curve.

## 9. Định nghĩa thành công

### Success criteria tổng (định tính)

Project thành công khi: (1) bạn giải thích được mọi lab cho người khác mà không nhìn sách — mục tiêu học tập; (2) mỗi lab có chaos challenge mà chính bạn từng "thua" ít nhất một lần — nghĩa là simulation đủ trung thực để dạy bạn điều mới; (3) repo public với demo link trở thành portfolio piece chứng minh năng lực distributed systems + tư duy adversarial cho hồ sơ Backend/AppSec Engineer.

### Definition of Done — Phase 0 (đo được)

- [ ] Cùng seed + cùng action log → event-log hash identical qua 100 runs liên tiếp (test tự động).
- [ ] Scrub ngược qua 10k events về điểm bất kỳ < 100 ms (benchmark trong CI).
- [ ] Ping-pong 3-node demo pass property test (fast-check) dưới delay/drop/reorder ngẫu nhiên.
- [ ] Simulation core có 0 dependency vào React/DOM (kiểm bằng import lint rule).
- [ ] Module contract v0 được validate bằng ít nhất 1 module giả lập (ping-pong) implement đủ interface.
- [ ] Coverage simulation core ≥ 80%.

### Definition of Done — Phase 1 (đo được)

- [ ] Lab Replication chạy đủ 3 mode (Story/Sandbox/Chaos).
- [ ] 3 chaos challenge, mỗi challenge có điều kiện thắng/thua kiểm chứng tự động bởi engine (không tự chấm bằng mắt).
- [ ] Metrics panel hiển thị ≥ 3 số real-time (ví dụ: replication lag, write throughput, stale-read count).
- [ ] Property test: write đã được ack với sync replication không bao giờ mất khi 1 follower chết.
- [ ] Trang Debrief xuất bản kèm ghi chú Chương 5 (MDX in-repo).
- [ ] Share URL `?seed=&scenario=` tái lập đúng cả 3 scripted scenario.

## Appendix — Open Questions (deferred)

- **(a) Ngôn ngữ nội dung labs/debrief:** English (portfolio reach — §9 nói repo public là portfolio piece) vs tiếng Việt (tốc độ học). Chốt trước Phase 1 vì ảnh hưởng toàn bộ content pipeline.
- **(b) Sync knowledge base:** ghi chú MDX in-repo có sync ra hệ thống ngoài (graphify/Notion) không, hay repo là single source of truth.
- **(c) Deploy target cụ thể:** Vercel vs GitHub Pages; tên miền riêng hay không. Không chặn Phase 0.
- **(d) XState spike ở Phase 3:** khi statechart phức tạp (Raft election), có đáng thử lại XState dưới virtual clock không — chỉ xét nếu pure reducer bắt đầu khó đọc.
