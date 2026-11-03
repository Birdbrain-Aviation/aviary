// winres writes a Windows resource object (.syso) holding an application
// icon, version information and a manifest. Put the output in a main
// package's folder as rsrc_windows_amd64.syso and `go build` links it in.
//
//	go run ./tools/winres -ico owl.ico -name Owl -desc "Owl ground station" -version 1.0.0 -out cmd/owl/rsrc_windows_amd64.syso
//	go run ./tools/winres -check build/windows/Owl.exe
package main

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	rtIcon      = 3
	rtGroupIcon = 14
	rtVersion   = 16
	rtManifest  = 24
	langEnUS    = 0x0409
)

type resource struct {
	typ, id, lang uint16
	data          []byte
}

func main() {
	ico := flag.String("ico", "", "icon file (.ico)")
	out := flag.String("out", "", "output .syso path")
	name := flag.String("name", "", "product name, e.g. Owl")
	desc := flag.String("desc", "", "file description")
	ver := flag.String("version", "1.0.0", "version a.b.c")
	exe := flag.String("exe", "", "original file name, e.g. Owl.exe")
	check := flag.String("check", "", "list the resources inside a built .exe and exit")
	flag.Parse()

	if *check != "" {
		if err := checkExe(*check); err != nil {
			fmt.Fprintln(os.Stderr, "check:", err)
			os.Exit(1)
		}
		return
	}
	if *ico == "" || *out == "" || *name == "" {
		flag.Usage()
		os.Exit(2)
	}
	icoData, err := os.ReadFile(*ico)
	if err != nil {
		fail(err)
	}
	res, err := iconResources(icoData)
	if err != nil {
		fail(fmt.Errorf("%s: %w", *ico, err))
	}
	if *exe == "" {
		*exe = *name + ".exe"
	}
	v, err := versionInfo(*name, *desc, *ver, *exe)
	if err != nil {
		fail(err)
	}
	res = append(res, resource{rtVersion, 1, langEnUS, v})
	res = append(res, resource{rtManifest, 1, langEnUS, []byte(manifest(*name, *ver))})
	obj := coff(res)
	if err := os.WriteFile(*out, obj, 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("%s: %d resources, %d bytes\n", *out, len(res), len(obj))
}

func fail(err error) { fmt.Fprintln(os.Stderr, "winres:", err); os.Exit(1) }

// ---------------------------------------------------------------- icons

// iconResources splits an .ico file into one RT_ICON per image plus the
// RT_GROUP_ICON directory that lists them.
func iconResources(b []byte) ([]resource, error) {
	if len(b) < 6 || binary.LittleEndian.Uint16(b[0:]) != 0 || binary.LittleEndian.Uint16(b[2:]) != 1 {
		return nil, errors.New("not an .ico file")
	}
	n := int(binary.LittleEndian.Uint16(b[4:]))
	if n == 0 || len(b) < 6+16*n {
		return nil, errors.New("icon has no images")
	}
	var out []resource
	group := new(bytes.Buffer)
	binary.Write(group, binary.LittleEndian, [3]uint16{0, 1, uint16(n)})
	for i := 0; i < n; i++ {
		e := b[6+16*i : 6+16*i+16]
		size := binary.LittleEndian.Uint32(e[8:])
		off := binary.LittleEndian.Uint32(e[12:])
		if uint64(off)+uint64(size) > uint64(len(b)) {
			return nil, fmt.Errorf("image %d runs past the end of the file", i)
		}
		id := uint16(i + 1)
		out = append(out, resource{rtIcon, id, langEnUS, b[off : off+size]})
		group.Write(e[0:12]) // width, height, colours, reserved, planes, bit count, bytes in resource
		binary.Write(group, binary.LittleEndian, id)
	}
	out = append(out, resource{rtGroupIcon, 1, langEnUS, group.Bytes()})
	return out, nil
}

// ---------------------------------------------------------------- version info

type vnode struct {
	key      string
	value    []byte
	valueLen uint16 // in bytes for binary values, in WORDs for text
	text     bool
	children []vnode
}

func utf16z(s string) []byte {
	u := utf16.Encode([]rune(s))
	u = append(u, 0)
	b := make([]byte, 2*len(u))
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[2*i:], c)
	}
	return b
}

func pad4(b *bytes.Buffer) {
	for b.Len()%4 != 0 {
		b.WriteByte(0)
	}
}

func (n vnode) bytes() []byte {
	b := new(bytes.Buffer)
	b.Write([]byte{0, 0}) // wLength, filled in below
	binary.Write(b, binary.LittleEndian, n.valueLen)
	t := uint16(0)
	if n.text {
		t = 1
	}
	binary.Write(b, binary.LittleEndian, t)
	b.Write(utf16z(n.key))
	pad4(b)
	b.Write(n.value)
	for _, c := range n.children {
		pad4(b)
		b.Write(c.bytes())
	}
	out := b.Bytes()
	binary.LittleEndian.PutUint16(out[0:], uint16(len(out)))
	return out
}

func parseVersion(v string) ([4]uint16, error) {
	var r [4]uint16
	parts := strings.Split(v, ".")
	if len(parts) > 4 {
		return r, fmt.Errorf("bad version %q", v)
	}
	for i, p := range parts {
		x, err := strconv.Atoi(p)
		if err != nil || x < 0 || x > 65535 {
			return r, fmt.Errorf("bad version %q", v)
		}
		r[i] = uint16(x)
	}
	return r, nil
}

func versionInfo(name, desc, ver, exe string) ([]byte, error) {
	v, err := parseVersion(ver)
	if err != nil {
		return nil, err
	}
	ms := uint32(v[0])<<16 | uint32(v[1])
	ls := uint32(v[2])<<16 | uint32(v[3])
	fixed := new(bytes.Buffer)
	binary.Write(fixed, binary.LittleEndian, []uint32{
		0xFEEF04BD, 0x00010000, // signature, structure version
		ms, ls, ms, ls, // file and product version
		0x3F, 0, // flags mask, flags
		0x00040004, // VOS_NT_WINDOWS32
		1, 0, // VFT_APP, subtype
		0, 0, // date
	})
	if desc == "" {
		desc = name
	}
	str := func(k, val string) vnode {
		vb := utf16z(val)
		return vnode{key: k, value: vb, valueLen: uint16(len(vb) / 2), text: true}
	}
	strs := []vnode{
		str("CompanyName", "Aviary"),
		str("FileDescription", desc),
		str("FileVersion", ver),
		str("InternalName", name),
		str("LegalCopyright", "Aviary rocketry tools"),
		str("OriginalFilename", exe),
		str("ProductName", name),
		str("ProductVersion", ver),
	}
	trans := new(bytes.Buffer)
	binary.Write(trans, binary.LittleEndian, []uint16{langEnUS, 1200})
	root := vnode{key: "VS_VERSION_INFO", value: fixed.Bytes(), valueLen: uint16(fixed.Len()), children: []vnode{
		{key: "StringFileInfo", text: true, children: []vnode{{key: "040904b0", text: true, children: strs}}},
		{key: "VarFileInfo", text: true, children: []vnode{{key: "Translation", value: trans.Bytes(), valueLen: uint16(trans.Len())}}},
	}}
	return root.bytes(), nil
}

func manifest(name, ver string) string {
	v, _ := parseVersion(ver)
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="Aviary.%s" version="%d.%d.%d.%d" processorArchitecture="amd64"/>
  <description>%s</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
`, name, v[0], v[1], v[2], v[3], name)
}

// ---------------------------------------------------------------- COFF object

// coff lays out a resource directory tree (type, then id, then language) in
// a .rsrc section. Directory offsets are relative to the section; the data
// entries hold RVAs, so each gets an ADDR32NB relocation against the section
// and the linker adds the section's address.
func coff(res []resource) []byte {
	sort.Slice(res, func(i, j int) bool {
		a, b := res[i], res[j]
		if a.typ != b.typ {
			return a.typ < b.typ
		}
		if a.id != b.id {
			return a.id < b.id
		}
		return a.lang < b.lang
	})
	type idGroup struct {
		id    uint16
		items []int
	}
	type typeGroup struct {
		typ uint16
		ids []*idGroup
	}
	var types []*typeGroup
	for i, r := range res {
		if len(types) == 0 || types[len(types)-1].typ != r.typ {
			types = append(types, &typeGroup{typ: r.typ})
		}
		tg := types[len(types)-1]
		if len(tg.ids) == 0 || tg.ids[len(tg.ids)-1].id != r.id {
			tg.ids = append(tg.ids, &idGroup{id: r.id})
		}
		ig := tg.ids[len(tg.ids)-1]
		ig.items = append(ig.items, i)
	}

	dirSize := func(n int) int { return 16 + 8*n }
	off := dirSize(len(types))
	typeOff := map[*typeGroup]int{}
	for _, tg := range types {
		typeOff[tg] = off
		off += dirSize(len(tg.ids))
	}
	idOff := map[*idGroup]int{}
	for _, tg := range types {
		for _, ig := range tg.ids {
			idOff[ig] = off
			off += dirSize(len(ig.items))
		}
	}
	entryOff := make([]int, len(res))
	for i := range res {
		entryOff[i] = off
		off += 16
	}
	dataOff := make([]int, len(res))
	for i, r := range res {
		off = (off + 7) &^ 7
		dataOff[i] = off
		off += len(r.data)
	}
	sec := make([]byte, (off+7)&^7)
	le := binary.LittleEndian
	writeDir := func(at, n int) { le.PutUint16(sec[at+14:], uint16(n)) } // id entries only
	writeEntry := func(at int, id uint32, target uint32) { le.PutUint32(sec[at:], id); le.PutUint32(sec[at+4:], target) }

	writeDir(0, len(types))
	for i, tg := range types {
		writeEntry(16+8*i, uint32(tg.typ), 0x80000000|uint32(typeOff[tg]))
		writeDir(typeOff[tg], len(tg.ids))
		for j, ig := range tg.ids {
			writeEntry(typeOff[tg]+16+8*j, uint32(ig.id), 0x80000000|uint32(idOff[ig]))
			writeDir(idOff[ig], len(ig.items))
			for k, ri := range ig.items {
				writeEntry(idOff[ig]+16+8*k, uint32(res[ri].lang), uint32(entryOff[ri]))
			}
		}
	}
	for i, r := range res {
		le.PutUint32(sec[entryOff[i]:], uint32(dataOff[i])) // section offset; relocated to an RVA
		le.PutUint32(sec[entryOff[i]+4:], uint32(len(r.data)))
		copy(sec[dataOff[i]:], r.data)
	}

	const hdr, shdr = 20, 40
	relocAt := hdr + shdr + len(sec)
	symAt := relocAt + 10*len(res)
	b := new(bytes.Buffer)
	binary.Write(b, le, struct {
		Machine              uint16
		NumberOfSections     uint16
		TimeDateStamp        uint32
		PointerToSymbolTable uint32
		NumberOfSymbols      uint32
		SizeOfOptionalHeader uint16
		Characteristics      uint16
	}{0x8664, 1, 0, uint32(symAt), 1, 0, 0x0004})
	var name [8]byte
	copy(name[:], ".rsrc")
	binary.Write(b, le, struct {
		Name                 [8]byte
		VirtualSize          uint32
		VirtualAddress       uint32
		SizeOfRawData        uint32
		PointerToRawData     uint32
		PointerToRelocations uint32
		PointerToLinenumbers uint32
		NumberOfRelocations  uint16
		NumberOfLinenumbers  uint16
		Characteristics      uint32
	}{name, 0, 0, uint32(len(sec)), hdr + shdr, uint32(relocAt), 0, uint16(len(res)), 0, 0x40000040})
	b.Write(sec)
	for i := range res {
		binary.Write(b, le, uint32(entryOff[i])) // where the RVA lives
		binary.Write(b, le, uint32(0))           // symbol 0: the section
		binary.Write(b, le, uint16(3))           // IMAGE_REL_AMD64_ADDR32NB
	}
	binary.Write(b, le, name)
	binary.Write(b, le, uint32(0)) // value
	binary.Write(b, le, uint16(1)) // section number
	binary.Write(b, le, uint16(0)) // type
	b.WriteByte(3)                 // IMAGE_SYM_CLASS_STATIC
	b.WriteByte(0)                 // aux symbols
	binary.Write(b, le, uint32(4)) // empty string table
	return b.Bytes()
}

// ---------------------------------------------------------------- checking a built .exe

func checkExe(path string) error {
	f, err := pe.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	oh, ok := f.OptionalHeader.(*pe.OptionalHeader64)
	if !ok {
		return errors.New("not a 64-bit Windows program")
	}
	subsystem := map[uint16]string{2: "windows (no console)", 3: "console"}[oh.Subsystem]
	fmt.Printf("%s: %s, subsystem %s\n", path, map[uint16]string{0x8664: "x64"}[f.Machine], subsystem)
	dd := oh.DataDirectory[pe.IMAGE_DIRECTORY_ENTRY_RESOURCE]
	if dd.VirtualAddress == 0 {
		return errors.New("no resource directory")
	}
	var sec *pe.Section
	for _, s := range f.Sections {
		if dd.VirtualAddress >= s.VirtualAddress && dd.VirtualAddress < s.VirtualAddress+s.VirtualSize {
			sec = s
		}
	}
	if sec == nil {
		return errors.New("resource directory is outside every section")
	}
	data, err := sec.Data()
	if err != nil {
		return err
	}
	base := dd.VirtualAddress - sec.VirtualAddress
	le := binary.LittleEndian
	rd := func(at uint32) []byte { return data[base+at:] }
	dir := func(at uint32) (ents [][2]uint32) {
		d := rd(at)
		n := int(le.Uint16(d[12:])) + int(le.Uint16(d[14:]))
		for i := 0; i < n; i++ {
			e := d[16+8*i:]
			ents = append(ents, [2]uint32{le.Uint32(e), le.Uint32(e[4:])})
		}
		return
	}
	names := map[uint32]string{rtIcon: "icon", rtGroupIcon: "icon group", rtVersion: "version", rtManifest: "manifest"}
	icons := map[uint32]uint32{}
	var group []byte
	for _, t := range dir(0) {
		for _, id := range dir(t[1] &^ 0x80000000) {
			for _, lang := range dir(id[1] &^ 0x80000000) {
				e := rd(lang[1])
				rva, size := le.Uint32(e), le.Uint32(e[4:])
				if rva < sec.VirtualAddress || rva+size > sec.VirtualAddress+uint32(len(data)) {
					return fmt.Errorf("%s %d points outside the section (rva %#x)", names[t[0]], id[0], rva)
				}
				blob := data[rva-sec.VirtualAddress : rva-sec.VirtualAddress+size]
				switch t[0] {
				case rtIcon:
					icons[id[0]] = size
					if !bytes.HasPrefix(blob, []byte("\x89PNG")) && le.Uint32(blob) != 40 {
						return fmt.Errorf("icon %d is neither PNG nor a bitmap", id[0])
					}
				case rtGroupIcon:
					group = blob
				case rtVersion:
					if !bytes.Contains(blob, utf16z("FileDescription")[:28]) {
						return errors.New("version info has no description")
					}
				case rtManifest:
					if !bytes.Contains(blob, []byte("asInvoker")) {
						return errors.New("manifest looks wrong")
					}
				}
				fmt.Printf("  %-10s id %-2d lang %#04x %6d bytes\n", names[t[0]], id[0], lang[0], size)
			}
		}
	}
	if group == nil {
		return errors.New("no icon group: Explorer would show a blank icon")
	}
	n := int(le.Uint16(group[4:]))
	for i := 0; i < n; i++ {
		e := group[6+14*i:]
		id, size := uint32(le.Uint16(e[12:])), le.Uint32(e[8:])
		if icons[id] != size {
			return fmt.Errorf("icon group entry %d refers to icon %d of %d bytes, found %d", i, id, size, icons[id])
		}
	}
	fmt.Printf("  icon group lists %d images, all present\n", n)
	return nil
}
