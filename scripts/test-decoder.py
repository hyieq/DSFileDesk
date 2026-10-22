"""Decode a locally generated MJPEG AVI through the shipped LibVLC (no NAS needed)."""
import ctypes as c
import io
from pathlib import Path
import struct
import tempfile
import time
from PIL import Image

root = Path(__file__).resolve().parents[1]
decoder = root / 'src-tauri/decoder'
lib = c.CDLL(str(decoder / 'libvlc.dll'), winmode=8)
def fn(name, result, *args):
    f = getattr(lib, name)
    f.restype, f.argtypes = result, args
    return f
ptr = c.c_void_p
new = fn('libvlc_new', ptr, c.c_int, c.POINTER(c.c_char_p))
media_new = fn('libvlc_media_new_path', ptr, ptr, c.c_char_p)
player_new = fn('libvlc_media_player_new_from_media', ptr, ptr)
play = fn('libvlc_media_player_play', c.c_int, ptr)
state = fn('libvlc_media_player_get_state', c.c_int, ptr)
class Stats(c.Structure):
    _fields_ = [('read_bytes',c.c_int),('input_bitrate',c.c_float),('demux_read_bytes',c.c_int),('demux_bitrate',c.c_float),('demux_corrupted',c.c_int),('demux_discontinuity',c.c_int),('decoded_video',c.c_int),('decoded_audio',c.c_int),('displayed',c.c_int),('lost',c.c_int),('played_audio',c.c_int),('lost_audio',c.c_int),('sent_packets',c.c_int),('sent_bytes',c.c_int),('send_bitrate',c.c_float)]
stats = fn('libvlc_media_get_stats', c.c_int, ptr, c.POINTER(Stats))
def chunk(kind, data): return kind + struct.pack('<I', len(data)) + data + (b'\0' if len(data)%2 else b'')
frames=[]
for n in range(60):
    img=Image.new('RGB',(128,96),(n*4,100,200-n*2))
    buf=io.BytesIO(); img.save(buf,format='JPEG'); frames.append(buf.getvalue())
header=struct.pack('<14I',100000,500000,0,16,60,0,1,50000,128,96,0,0,0,0)
stream=struct.pack('<4s4sIHHIIIIIIIIhhhh',b'vids',b'MJPG',0,0,0,0,1,10,0,60,50000,0xffffffff,0,0,0,128,96)
bitmap=struct.pack('<IiiHH4sIiiII',40,128,96,1,24,b'MJPG',128*96*3,0,0,0,0)
hdrl=chunk(b'LIST',b'hdrl'+chunk(b'avih',header)+chunk(b'LIST',b'strl'+chunk(b'strh',stream)+chunk(b'strf',bitmap)))
index=b''; movi=b'movi'
for frame in frames:
    index+=struct.pack('<4sIII',b'00dc',16,len(movi),len(frame))
    movi+=chunk(b'00dc',frame)
avi=chunk(b'RIFF',b'AVI '+hdrl+chunk(b'LIST',movi)+chunk(b'idx1',index))
with tempfile.TemporaryDirectory(prefix='filedesk-decoder-') as temp:
    sample=Path(temp)/'sample.avi'; sample.write_bytes(avi)
    args=(c.c_char_p*5)(b'--quiet',b'--no-audio',b'--vout=dummy',b'--no-video-title-show',b'--no-snapshot-preview')
    instance=new(len(args),args); assert instance, 'LibVLC initialization failed'
    media=media_new(instance,str(sample).encode()); assert media
    player=player_new(media); assert player
    try:
        assert play(player)==0
        deadline=time.monotonic()+10
        result=Stats()
        while time.monotonic()<deadline:
            stats(media,c.byref(result))
            if result.decoded_video>=5: break
            assert state(player)!=7,'Decoder entered error state'
            time.sleep(.1)
        assert result.decoded_video>=5, f'Only {result.decoded_video} frames decoded'
        fn('libvlc_media_player_set_pause',None,ptr,c.c_int)(player,1)
        fn('libvlc_media_player_set_time',None,ptr,c.c_int64)(player,3000)
        fn('libvlc_audio_set_volume',c.c_int,ptr,c.c_int)(player,50)
        print(f'PASS: LibVLC decoded {result.decoded_video} video frames; pause, seek, volume ABI verified')
    finally:
        fn('libvlc_media_player_stop',None,ptr)(player)
        fn('libvlc_media_player_release',None,ptr)(player)
        fn('libvlc_media_release',None,ptr)(media)
        fn('libvlc_release',None,ptr)(instance)
