#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#include <stdlib.h>
#include <string.h>

typedef void (*ColorfulSpeechCallback)(const char *kind, const char *text);

@interface ColorfulSpeechController : NSObject
@property(nonatomic, strong) AVAudioEngine *audioEngine;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *recognitionRequest;
@property(nonatomic, strong) SFSpeechRecognitionTask *recognitionTask;
@property(nonatomic, copy) NSString *lastTranscript;
@property(nonatomic) ColorfulSpeechCallback callback;
@property(nonatomic, strong) NSObject *lock;
+ (instancetype)shared;
- (NSString *)startWithLanguage:(NSString *)language callback:(ColorfulSpeechCallback)callback;
- (void)stop;
- (NSString *)privacyUsageDescriptionError;
@end

@implementation ColorfulSpeechController

+ (instancetype)shared {
  static ColorfulSpeechController *controller = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    controller = [[ColorfulSpeechController alloc] init];
    controller.lock = [[NSObject alloc] init];
  });
  return controller;
}

- (NSString *)startWithLanguage:(NSString *)language callback:(ColorfulSpeechCallback)callback {
  @synchronized(self.lock) {
    [self stopLockedWithStatus:NO];
    self.callback = callback;
    self.lastTranscript = @"";

    NSString *privacyError = [self privacyUsageDescriptionError];
    if (privacyError != nil) {
      return privacyError;
    }

    if (![self requestSpeechAuthorization]) {
      return @"Speech recognition permission was denied.";
    }
    if (![self requestMicrophoneAuthorization]) {
      return @"Microphone access was denied.";
    }

    NSLocale *locale = [[NSLocale alloc] initWithLocaleIdentifier:[self localeIdentifierForLanguage:language]];
    SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
    if (recognizer == nil || !recognizer.isAvailable) {
      return [NSString stringWithFormat:@"Speech recognizer is not available for %@.", locale.localeIdentifier];
    }

    AVAudioEngine *audioEngine = [[AVAudioEngine alloc] init];
    SFSpeechAudioBufferRecognitionRequest *request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    request.shouldReportPartialResults = YES;

    AVAudioInputNode *inputNode = audioEngine.inputNode;
    AVAudioFormat *format = [inputNode outputFormatForBus:0];
    [inputNode removeTapOnBus:0];
    AVAudioNodeTapBlock tapBlock = ^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
      [request appendAudioPCMBuffer:buffer];
    };
    NSError *tapError = nil;
    BOOL tapInstalled = NO;
#if defined(MAC_OS_VERSION_27_0) && MAC_OS_X_VERSION_MAX_ALLOWED >= MAC_OS_VERSION_27_0
    if (@available(macOS 27.0, *)) {
      tapInstalled = [inputNode installTapOnBus:0
                                     bufferSize:1024
                                         format:format
                                          error:&tapError
                                          block:tapBlock];
    } else {
#endif
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      [inputNode installTapOnBus:0 bufferSize:1024 format:format block:tapBlock];
#pragma clang diagnostic pop
      tapInstalled = YES;
#if defined(MAC_OS_VERSION_27_0) && MAC_OS_X_VERSION_MAX_ALLOWED >= MAC_OS_VERSION_27_0
    }
#endif
    if (!tapInstalled) {
      return [NSString stringWithFormat:@"Could not install microphone tap: %@",
                                        tapError.localizedDescription ?: @"unknown error"];
    }

    NSError *startError = nil;
    [audioEngine prepare];
    if (![audioEngine startAndReturnError:&startError]) {
      [inputNode removeTapOnBus:0];
      return [NSString stringWithFormat:@"Could not start microphone capture: %@",
                                        startError.localizedDescription ?: @"unknown error"];
    }

    self.audioEngine = audioEngine;
    self.recognitionRequest = request;

    __weak ColorfulSpeechController *weakSelf = self;
    self.recognitionTask =
        [recognizer recognitionTaskWithRequest:request
                                  resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
                                    ColorfulSpeechController *strongSelf = weakSelf;
                                    if (strongSelf == nil) {
                                      return;
                                    }
                                    if (result != nil) {
                                      NSString *transcript = result.bestTranscription.formattedString ?: @"";
                                      strongSelf.lastTranscript = transcript;
                                      [strongSelf emitKind:(result.isFinal ? @"done" : @"delta") text:transcript];
                                      if (result.isFinal) {
                                        @synchronized(strongSelf.lock) {
                                          [strongSelf stopLockedWithStatus:YES];
                                        }
                                      }
                                    }
                                    if (error != nil) {
                                      [strongSelf emitKind:@"error" text:error.localizedDescription ?: @"Speech recognition failed."];
                                      @synchronized(strongSelf.lock) {
                                        [strongSelf stopLockedWithStatus:YES];
                                      }
                                    }
                                  }];

    [self emitKind:@"status" text:@"recording"];
    return nil;
  }
}

- (void)stop {
  @synchronized(self.lock) {
    [self stopLockedWithStatus:YES];
  }
}

- (void)stopLockedWithStatus:(BOOL)sendStatus {
  if (self.audioEngine != nil) {
    [self.audioEngine.inputNode removeTapOnBus:0];
    [self.audioEngine stop];
  }
  [self.recognitionRequest endAudio];
  if (self.recognitionTask != nil) {
    [self.recognitionTask finish];
  }
  self.audioEngine = nil;
  self.recognitionRequest = nil;
  self.recognitionTask = nil;
  if (sendStatus) {
    [self emitKind:@"status" text:@"stopped"];
  }
}

- (NSString *)privacyUsageDescriptionError {
  NSArray<NSString *> *requiredKeys = @[
    @"NSSpeechRecognitionUsageDescription",
    @"NSMicrophoneUsageDescription",
  ];

  for (NSString *key in requiredKeys) {
    id value = [NSBundle.mainBundle objectForInfoDictionaryKey:key];
    if (![value isKindOfClass:NSString.class] || ((NSString *)value).length == 0) {
      return [NSString stringWithFormat:@"%@ is missing from the app Info.plist. Rebuild or launch the bundled .app before starting voice input.", key];
    }
  }

  return nil;
}

- (BOOL)requestSpeechAuthorization {
  SFSpeechRecognizerAuthorizationStatus status = [SFSpeechRecognizer authorizationStatus];
  if (status == SFSpeechRecognizerAuthorizationStatusAuthorized) {
    return YES;
  }
  if (status == SFSpeechRecognizerAuthorizationStatusDenied ||
      status == SFSpeechRecognizerAuthorizationStatusRestricted) {
    return NO;
  }

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block BOOL authorized = NO;
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus authStatus) {
    authorized = authStatus == SFSpeechRecognizerAuthorizationStatusAuthorized;
    dispatch_semaphore_signal(semaphore);
  }];
  dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
  return authorized;
}

- (BOOL)requestMicrophoneAuthorization {
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (status == AVAuthorizationStatusAuthorized) {
    return YES;
  }
  if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted) {
    return NO;
  }

  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block BOOL authorized = NO;
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                           completionHandler:^(BOOL granted) {
                             authorized = granted;
                             dispatch_semaphore_signal(semaphore);
                           }];
  dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
  return authorized;
}

- (NSString *)localeIdentifierForLanguage:(NSString *)language {
  if ([language isEqualToString:@"zh"]) {
    return @"zh-CN";
  }
  if ([language isEqualToString:@"en"]) {
    return @"en-US";
  }
  return NSLocale.currentLocale.localeIdentifier;
}

- (void)emitKind:(NSString *)kind text:(NSString *)text {
  if (self.callback == NULL) {
    return;
  }
  self.callback(kind.UTF8String ?: "", text.UTF8String ?: "");
}

@end

char *colorful_macos_speech_start(const char *language, ColorfulSpeechCallback callback) {
  NSString *languageValue = language == NULL ? @"auto" : [NSString stringWithUTF8String:language];
  NSString *error = [[ColorfulSpeechController shared] startWithLanguage:languageValue callback:callback];
  if (error == nil) {
    return NULL;
  }
  return strdup(error.UTF8String ?: "macOS speech failed.");
}

void colorful_macos_speech_stop(void) {
  [[ColorfulSpeechController shared] stop];
}

void colorful_macos_speech_free(char *pointer) {
  free(pointer);
}
