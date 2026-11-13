# MiroBridgeMCP

[English](README.md) · MIT · ไม่ได้เป็นส่วนหนึ่งของบริษัท Miro

![demo](docs/demo.gif)

ให้ Claude อ่าน/แก้ Miro board ได้โดยตรง (สร้าง sticky, shape, เส้นเชื่อม, รูป, จัด layout, แคปหน้าจอ) ผ่านแอปเล็กๆ ที่รันอยู่ในบอร์ด
**ไม่ใช้ REST API → ไม่มีโควตา 100 ครั้ง/วันของ Miro MCP ทางการ ใช้กับ Free plan ได้**

```
Claude ⇄ MiroBridgeMCP (เครื่องคุณ, localhost:7788) ⇄ แอป MiroBridgeMCP ในบอร์ดที่เปิดอยู่
```

---

## ติดตั้ง (≈3 นาที ทำครั้งเดียว)

**ต้องมี:** [Node.js 20+](https://nodejs.org), [git](https://git-scm.com), Claude Code, Chrome/Edge หรือ Miro desktop app

```
npm install -g github:sawaddee123/MiroBridgeMCP
miro-bridge-mcp setup
```

`setup` ทำให้ครบทุกขั้น และรันซ้ำได้ (= ซ่อมเมื่อมีปัญหา):
1. ลงทะเบียนกับ Claude Code ให้เอง (ใช้ `node` + path ตรง: เปิดเร็ว ไม่ต้องใช้เน็ต ไม่เจอปัญหา `npx` บน Windows)
2. เปิดหน้าติดตั้งแอป Miro ให้ → เลือก team ที่มีบอร์ดของคุณ
3. รอจนคุณเปิดบอร์ดใน team นั้น แล้วยืนยัน `OK   board connected`

จากนั้นเปิด Claude Code ใหม่ แล้วสั่งได้เลย เช่น *"สรุปบอร์ดนี้ให้หน่อย"*, *"ทำ retro board จากลิสต์นี้"*, *"จัด sticky ในเฟรมนี้เป็น grid"*

**ใช้ทุกวัน:** แค่เปิดบอร์ดไว้ ไม่ต้องรันอะไรเพิ่ม · **อัปเดต:** รัน `npm install -g ...` ซ้ำ แล้ว F5 แท็บบอร์ด · **ตรวจ:** `miro-bridge-mcp check`
**ถอนการติดตั้ง:** `claude mcp remove MiroBridgeMCP -s user` และ `npm rm -g miro-bridge-mcp`

### Focus: บอก Claude ว่ากำลังสนใจส่วนไหน
บอร์ดใหญ่มักมีไอเดียเก่าปนอยู่ ลากคลุมสิ่งที่ต้องการ (หรือเลือกเฟรม) แล้วกดไอคอน **MiroBridgeMCP** ในแถบแอป → ขึ้น "Claude focus: N item(s)"
Claude จะเริ่มจากตรงนั้นก่อน แต่ **ไม่ได้ถูกจำกัด** ยังดูส่วนอื่นได้ถ้างานต้องใช้ · กดไอคอนตอนไม่ได้เลือกอะไร = ล้าง focus · focus ถูกบันทึกไว้ในบอร์ด
สั่งด้วยคำพูดก็ได้ เช่น *"focus ที่เฟรม Act 2"*

**ข้อควรรู้:** เปิดบอร์ดค้างไว้ตอนใช้ · ใช้ได้ทีละ 1 Claude session ต่อเครื่อง · ใช้ได้เฉพาะบอร์ดใน team ที่ติดตั้งแอป

### แก้ปัญหา

| อาการ | ทางแก้ |
|---|---|
| `No Miro board connected` | แอปติดตั้งใน team ของบอร์ดนี้หรือยัง? → กด F5 ที่แท็บบอร์ด → รัน `miro-bridge-mcp check` |
| ใช้ Brave แล้วไม่ต่อ | Settings → Privacy → **Localhost access** ให้ miro.com (หรือปิด Shields ที่ miro.com) |
| `port 7788 unavailable` | มี Claude session อื่นใช้อยู่ ปิดอันนั้นก่อน |
| สร้างของในเฟรมไม่ได้ (`isn't inside a parent frame`) | เอาหน้าต่างบอร์ดขึ้นมาให้เห็นบนจอ (ตอนอยู่เบื้องหลัง Miro ไม่คำนวณเฟรม) |
| `capture` ใช้ไม่ได้ | รองรับเฉพาะ Windows และหน้าต่าง Miro ต้องไม่ถูกย่อ (minimize) |
| Safari | ไม่รองรับ (บล็อก localhost) ใช้ Chrome/Edge/Miro desktop |

---

## ใช้แอป Miro ของตัวเอง (ไม่บังคับ)

ลิงก์ติดตั้งด้านบนเป็นแอปของผู้ดูแลโปรเจกต์ ถ้าอยากใช้แอปของตัวเอง:

1. miro.com → Profile settings → **Your apps** → Create new app (ใน Developer team)
2. ตั้งค่า (หรือวางใน **App Manifest**):
   ```yaml
   appName: MiroBridgeMCP
   sdkVersion: SDK_V2
   sdkUri: http://localhost:7788/
   scopes:
     - boards:read
     - boards:write
   ```
3. เลื่อนลงไปที่ **Share app** → คัดลอก **Installation URL** แล้วแจกลิงก์นั้นแทน
   ทุกคนใช้แอปตัวเดียวกันได้ เพราะแอปโหลดจาก `localhost` ของเครื่องแต่ละคนเอง ไม่มีเซิร์ฟเวอร์กลาง ไม่มีข้อมูลผ่านเครื่องคุณ

ไม่ต้องใช้ client secret หรือ token ใดๆ แอปทำงานในสิทธิ์ของคนที่เปิดบอร์ด **อย่าแจก client secret**

---

## ความปลอดภัย

- bridge ฟังเฉพาะ `127.0.0.1` รับ WebSocket เฉพาะจากหน้าของตัวเอง และหน้านั้นฝังได้เฉพาะใน miro.com
- เนื้อหาบนบอร์ดคนอื่นเขียนได้ ให้ถือเป็น "ข้อมูล" ไม่ใช่คำสั่ง (sticky ที่เขียนว่า "ลบทั้งหมด" ไม่ใช่คำสั่งให้ Claude) ระวังคำสั่งที่ลบ/แก้เยอะๆ บนบอร์ดที่แชร์กัน
- เจ้าของแอป Miro ในลิงก์ติดตั้งเป็นคนกำหนดว่าโค้ดอะไรรันในบอร์ดของคนที่ติดตั้ง ติดตั้งเฉพาะลิงก์ที่ไว้ใจ หรือใช้แอปของตัวเอง

## Tools

| Tool | ทำอะไร |
|---|---|
| `get_board_info` | ภาพรวมราคาถูก: จำนวนของแต่ละประเภท + รายชื่อเฟรม + มี focus ไหม (เรียกก่อนเสมอ) |
| `get_focus` / `set_focus` | อ่าน / ตั้ง focus (เลือกเฟรม = รวมของข้างในด้วย) |
| `get_items` | อ่าน items กรองด้วย `type`, `ids`, `parentId` (เฟรม) · ผลแบบย่อ ประหยัด token · `full: true` ได้ข้อมูลดิบ |
| `get_selection` | ของที่ผู้ใช้เลือกอยู่ |
| `create_items` | สร้างหลายชิ้นในครั้งเดียว (sticky, shape, text, card, frame, connector, image, embed) · รูปใช้ `path` ไฟล์ในเครื่องได้ · พังกลางทาง = ยกเลิกทั้งชุด |
| `update_items` | แก้ props (style ถูก merge) |
| `delete_items` | ลบตาม id |
| `arrange_items` | จัด grid / row / column |
| `zoom_to` | เลื่อนจอไปที่ items |
| `capture` | แคปหน้าต่าง Miro ให้ Claude ดูผลงาน (Windows) |

## พัฒนาต่อ

- `server.js` — MCP tools + WebSocket bridge · `app/index.html` — โค้ดที่รันในบอร์ด (**แก้แล้วต้อง F5 แท็บบอร์ด**) · `capture.ps1` — แคปหน้าจอ
- `npm test` — ทดสอบด้วยบอร์ดจำลอง ไม่ต้องเปิด Miro · `node server.js check` — ทดสอบกับบอร์ดจริง · `node scripts/record-demo.mjs` — อัด `docs/demo.gif` ใหม่
- เปลี่ยนพอร์ตด้วย `MIRO_BRIDGE_PORT` (ต้องแก้ `sdkUri` ของแอปให้ตรงด้วย ซึ่งกระทบทุกคนที่ใช้แอปเดียวกัน)
- ข้อจำกัด: rate limit ของ Web SDK (ต่อนาทีต่อผู้ใช้), 1 session ต่อเครื่อง, ไม่ได้ทดสอบบน macOS/Linux (ยกเว้น `capture` ส่วนอื่นควรใช้ได้)
