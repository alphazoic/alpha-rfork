//go:build !linux && !darwin && !windows

package checkpoint

import "os"

const platformSupported = false

func platformMkdir(string) error                      { return ErrUnsupported }
func platformPrivate(*os.File, bool) error            { return ErrUnsupported }
func platformPin(string, *os.File) (func(), error)    { return nil, ErrUnsupported }
func platformCreate(*Store, string) (*os.File, error) { return nil, ErrUnsupported }
func platformRename(*Store, string, string) error     { return ErrUnsupported }
func platformDirectorySync(*os.File) error            { return ErrUnsupported }
func platformFileSync(*os.File) error                 { return ErrUnsupported }
func platformLock(*os.File) (func() error, error)     { return nil, ErrUnsupported }
