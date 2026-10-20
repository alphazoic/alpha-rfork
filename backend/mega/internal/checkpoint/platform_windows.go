package checkpoint

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const platformSupported = true

func privateSecurity() (*windows.SecurityAttributes, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	sid := user.User.Sid.String()
	// Protect at creation, including the owner SID under elevated tokens whose
	// default object owner could otherwise be the Administrators group.
	sd, err := windows.SecurityDescriptorFromString("O:" + sid + "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)")
	if err != nil {
		return nil, err
	}
	return &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}, nil
}

func windowsPath(path string) (*uint16, error) { return windows.UTF16PtrFromString(`\\?\` + path) }

func platformMkdir(dir string) error {
	volume := filepath.VolumeName(dir)
	if len(volume) != 2 || volume[1] != ':' {
		return ErrUnsupported
	}
	root, err := windows.UTF16PtrFromString(volume + `\`)
	if err != nil || windows.GetDriveType(root) != windows.DRIVE_FIXED {
		return ErrUnsupported
	}
	var fsname [32]uint16
	if windows.GetVolumeInformation(root, nil, 0, nil, nil, nil, &fsname[0], uint32(len(fsname))) != nil || windows.UTF16ToString(fsname[:]) != "NTFS" {
		return ErrUnsupported
	}
	sa, err := privateSecurity()
	if err != nil {
		return err
	}
	path, err := windowsPath(dir)
	if err != nil {
		return err
	}
	return windows.CreateDirectory(path, sa)
}

func platformPrivate(f *os.File, directory bool) error {
	handle := windows.Handle(f.Fd())
	var fi windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &fi) != nil || fi.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		(fi.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory || !directory && fi.NumberOfLinks != 1 {
		return ErrUnsafe
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return ErrUnsafe
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return ErrUnsafe
	}
	owner, _, err := sd.Owner()
	if err != nil || !owner.Equals(user.User.Sid) {
		return ErrUnsafe
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return ErrUnsafe
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 {
		return ErrUnsafe
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return ErrUnsafe
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &ace) != nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return ErrUnsafe
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.IsValid() || !sid.Equals(user.User.Sid) && !sid.Equals(system) {
			return ErrUnsafe
		}
	}
	return nil
}

func platformPin(dir string, directory *os.File) (func(), error) {
	// Absolute MoveFileEx paths remain stable while every ancestor denies delete
	// sharing. Reparse components are rejected instead of following redirects.
	volume := filepath.VolumeName(dir)
	parts := strings.Split(strings.TrimPrefix(dir, volume+`\`), `\`)
	if len(parts) > 128 {
		return nil, ErrUnsafe
	}
	paths := []string{volume + `\`}
	for _, part := range parts {
		if part != "" {
			paths = append(paths, filepath.Join(paths[len(paths)-1], part))
		}
	}
	var files []*os.File
	unpin := func() {
		for i := len(files) - 1; i >= 0; i-- {
			_ = files[i].Close()
		}
	}
	for _, path := range paths {
		name, err := windowsPath(path)
		if err != nil {
			unpin()
			return nil, ErrUnsafe
		}
		h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
			windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			unpin()
			return nil, ErrUnsafe
		}
		f := os.NewFile(uintptr(h), path)
		files = append(files, f)
		var fi windows.ByHandleFileInformation
		if windows.GetFileInformationByHandle(h, &fi) != nil || fi.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || fi.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			unpin()
			return nil, ErrUnsafe
		}
	}
	a, err := directory.Stat()
	if err != nil {
		unpin()
		return nil, ErrUnsafe
	}
	b, err := files[len(files)-1].Stat()
	if err != nil || !os.SameFile(a, b) {
		unpin()
		return nil, ErrUnsafe
	}
	return unpin, nil
}

func platformCreate(s *Store, name string) (*os.File, error) {
	sa, err := privateSecurity()
	if err != nil {
		return nil, err
	}
	path, err := windowsPath(filepath.Join(s.path, name))
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(path, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, sa,
		windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_WRITE_THROUGH, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(h), name), nil
}

func platformFileSync(f *os.File) error { return f.Sync() }
func platformDirectorySync(*os.File) error {
	// NTFS creation uses write-through handles and replacement uses
	// MOVEFILE_WRITE_THROUGH; directories cannot be portably FlushFileBuffers'd.
	return nil
}
func platformRename(s *Store, from, to string) error {
	a, err := windowsPath(filepath.Join(s.path, from))
	if err != nil {
		return err
	}
	b, err := windowsPath(filepath.Join(s.path, to))
	if err != nil {
		return err
	}
	// https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw
	return windows.MoveFileEx(a, b, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
func platformLock(f *os.File) (func() error, error) {
	overlap := new(windows.Overlapped)
	h := windows.Handle(f.Fd())
	err := windows.LockFileEx(h, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlap)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return nil, ErrBusy
	}
	if err != nil {
		return nil, ErrIO
	}
	return func() error { return windows.UnlockFileEx(h, 0, 1, 0, overlap) }, nil
}
